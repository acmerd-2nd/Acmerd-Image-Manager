/**
 * V1.1 Phase B (PB-1) — GitHub Contents API 客户端 + 写入租约
 * 依据: docs/v1.1/04-phase-b-design-gate.md §2/§3/§4/§5（Owner 裁决冻结）
 *
 * 硬约束（Gate §12 冻结）:
 *   - GITHUB_TOKEN 仅存在于 Worker Secret，绝不进入前端 bundle / Git
 *   - 同一 Asset+Language 写入串行 = Supabase 租约表（跨 isolate 有效），
 *     内存 Map / pg_advisory 会话锁均被否决
 *   - remote success → DB success；任何崩溃窗口由 sweeper 收敛（§3）
 *   - 重试矩阵（§5）: 409/422 重取 sha 重试 1 次；限流立即失败；
 *     5xx/网络 退避重试 ≤3 次；单次操作 GitHub 子请求上限 8
 *   - 路径冻结: assets/{asset-uuid}/{langCode}/{filename}（Q1）
 */

export interface GithubEnv {
  GITHUB_TOKEN?: string
  GITHUB_IMAGES_OWNER?: string
  GITHUB_IMAGES_REPO?: string
  GITHUB_IMAGES_BRANCH?: string
}

export interface GithubConfig {
  token: string
  owner: string
  repo: string
  branch: string
}

/** 配置未就绪（部署后 Owner 配 Secret/vars 前，端点必须 503 而非半工作） */
export function ghConfig(env: GithubEnv): GithubConfig | null {
  const token = env.GITHUB_TOKEN
  const owner = env.GITHUB_IMAGES_OWNER
  const repo = env.GITHUB_IMAGES_REPO
  if (!token || !owner || !repo) return null
  return { token, owner, repo, branch: env.GITHUB_IMAGES_BRANCH || 'main' }
}

export class GithubError extends Error {
  constructor(
    public code:
      | 'GITHUB_RATE_LIMITED'
      | 'GITHUB_AUTH_FAILED'
      | 'GITHUB_PATH_CONFLICT'
      | 'GITHUB_NETWORK'
      | 'GITHUB_SUBREQUEST_BUDGET'
      | 'GITHUB_UNEXPECTED',
    message: string,
  ) {
    super(message)
  }
}

const API = 'https://api.github.com'

function ghHeaders(cfg: GithubConfig, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'acmerd-image-manager',
  }
}

/** git blob sha（GitHubContents API 的 sha 即 sha1("blob {len}\0" + content)） */
export async function computeGitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const merged = new Uint8Array(header.length + bytes.length)
  merged.set(header, 0)
  merged.set(bytes, header.length)
  const digest = await crypto.subtle.digest('SHA-1', merged)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// 子请求预算：单次业务操作（含 GET/PUT/DELETE/重试）总数硬上限（Gate §5）
// ---------------------------------------------------------------------------
class SubrequestBudget {
  private used = 0
  constructor(private readonly max: number) {}
  consume(): void {
    if (++this.used > this.max) {
      throw new GithubError('GITHUB_SUBREQUEST_BUDGET', `GitHub subrequest budget (${this.max}) exhausted`)
    }
  }
}

async function ghFetch(cfg: GithubConfig, url: string, init: RequestInit, budget: SubrequestBudget): Promise<Response> {
  budget.consume()
  const extra = (init.headers ?? {}) as Record<string, string>
  const accept = extra['Accept'] ?? 'application/vnd.github+json'
  return fetch(url, { ...init, headers: { ...ghHeaders(cfg, accept), ...extra } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// GET 元数据（sha/size；不取 content，sweeper 与删除前置都只用 sha）
// 返回 null = 404（目标态"不存在"）
// ---------------------------------------------------------------------------
export async function ghGetMeta(cfg: GithubConfig, sourcePath: string, budget?: SubrequestBudget): Promise<{ sha: string; size: number } | null> {
  const b = budget ?? new SubrequestBudget(8)
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${sourcePath}?ref=${cfg.branch}`
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await ghFetch(cfg, url, { method: 'GET', headers: { Accept: 'application/vnd.github.object+json' } }, b)
    } catch (e) {
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw new GithubError('GITHUB_NETWORK', `contents GET failed: ${String(e)}`)
    }
    if (res.status === 404) return null
    if (res.status === 403) {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
      }
      throw new GithubError('GITHUB_AUTH_FAILED', 'contents GET forbidden')
    }
    if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
    if (!res.ok) {
      if (res.status >= 500 && attempt < 2) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw new GithubError('GITHUB_UNEXPECTED', `contents GET status ${res.status}`)
    }
    const body = (await res.json()) as { sha?: string; size?: number; type?: string }
    if (!body.sha) throw new GithubError('GITHUB_UNEXPECTED', 'contents GET missing sha')
    return { sha: body.sha, size: body.size ?? 0 }
  }
}

// ---------------------------------------------------------------------------
// PUT（创建/更新；幂等语义见 Gate §4）:
//   * 先 GET 元数据取 sha（404 → 创建）
//   * 422 already exists / 409 冲突 → 重取 sha 重试一次
//   * 成功后必须校验 response.content.sha === 本地预期 blob sha（Owner 裁决）
// ---------------------------------------------------------------------------
export async function ghPutFile(
  cfg: GithubConfig,
  sourcePath: string,
  bytes: Uint8Array,
  expectedSha: string,
): Promise<void> {
  const b = new SubrequestBudget(8)
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${sourcePath}`
  let retried = false
  for (;;) {
    const meta = await ghGetMeta(cfg, sourcePath, b)
    let res: Response
    try {
      res = await ghFetch(
        cfg,
        url,
        {
          method: 'PUT',
          headers: { Accept: 'application/vnd.github+json' },
          body: JSON.stringify({
            message: `upload ${sourcePath} (acmerd-image-manager)`,
            content: bytesToBase64(bytes),
            branch: cfg.branch,
            ...(meta ? { sha: meta.sha } : {}),
          }),
        },
        b,
      )
    } catch (e) {
      throw new GithubError('GITHUB_NETWORK', `contents PUT failed: ${String(e)}`)
    }

    if (res.ok) {
      const body = (await res.json()) as { content?: { sha?: string } }
      const returnedSha = body.content?.sha
      if (returnedSha !== expectedSha) {
        // 远端落盘内容与预期不一致 → 视为失败（调用方进入 failed/补偿路径）
        throw new GithubError('GITHUB_PATH_CONFLICT', `content sha mismatch: got ${returnedSha}, expected ${expectedSha}`)
      }
      return
    }

    const conflict = res.status === 422 || res.status === 409
    if (conflict && !retried) {
      retried = true // 重取 sha 后重试一次（租约失效兜底，Gate §5）
      continue
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
    }
    if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
    if (res.status === 422 && !retried) {
      // 已存在但内容不同类冲突
      throw new GithubError('GITHUB_PATH_CONFLICT', 'path occupied by different content')
    }
    throw new GithubError('GITHUB_UNEXPECTED', `contents PUT status ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// DELETE（幂等；Gate §4）: 404 = 目标态已达 → 成功
// ---------------------------------------------------------------------------
export async function ghDeleteFile(cfg: GithubConfig, sourcePath: string): Promise<void> {
  const b = new SubrequestBudget(8)
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${sourcePath}`
  let retried = false
  for (;;) {
    const meta = await ghGetMeta(cfg, sourcePath, b)
    if (!meta) return // 已不存在 → 成功
    let res: Response
    try {
      res = await ghFetch(
        cfg,
        url,
        {
          method: 'DELETE',
          headers: { Accept: 'application/vnd.github+json' },
          body: JSON.stringify({
            message: `delete ${sourcePath} (acmerd-image-manager)`,
            sha: meta.sha,
            branch: cfg.branch,
          }),
        },
        b,
      )
    } catch (e) {
      throw new GithubError('GITHUB_NETWORK', `contents DELETE failed: ${String(e)}`)
    }
    if (res.ok || res.status === 404) return
    const conflict = res.status === 409 || res.status === 422
    if (conflict && !retried) {
      retried = true
      continue
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
    }
    if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
    throw new GithubError('GITHUB_UNEXPECTED', `contents DELETE status ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// 5xx/网络退避包装（GET/PUT/DELETE 内部对 5xx 已有退避；此处供调用方整体重试
// GITHUB_NETWORK 场景，总尝试 ≤3，Gate §5）
// ---------------------------------------------------------------------------
export async function withNetworkRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof GithubError && e.code !== 'GITHUB_NETWORK') throw e
      lastErr = e
      if (i < attempts - 1) await sleep(500 * 2 ** i)
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// 租约（Supabase RPC；0014 claim/release，仅 service_role）
// 返回 false = LEASE_BUSY（另一写进行中且未过期）
// ---------------------------------------------------------------------------
export async function claimLease(env: { SUPABASE_URL: string }, svcHeaders: Record<string, string>, resourceKey: string, ownerId: string, ttlSeconds = 120): Promise<boolean> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_github_lease`, {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ p_resource_key: resourceKey, p_owner: ownerId, p_ttl_seconds: ttlSeconds }),
  })
  if (!res.ok) throw new Error(`claim_github_lease failed: ${res.status}`)
  const result = (await res.json()) as boolean | null
  return result === true
}

export async function releaseLease(env: { SUPABASE_URL: string }, svcHeaders: Record<string, string>, resourceKey: string, ownerId: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/release_github_lease`, {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ p_resource_key: resourceKey, p_owner: ownerId }),
  })
}

// ---------------------------------------------------------------------------
// raw 公开 URL（下载 302 目标；makeImageUrl 的 Worker 侧对偶实现）
// ---------------------------------------------------------------------------
export function githubRawUrl(cfg: GithubConfig, sourcePath: string): string {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${sourcePath}`
}

// ---------------------------------------------------------------------------
// V1.5 B1 — Git Data API 批量通道（360 序列专用；普通图继续走 Contents API）
// 设计依据: docs/v1.5/02-design-gate.md §G3（Owner 批准方案 B）:
//   blobs 内容寻址幂等（同内容同 sha）→ 单 tree（base_tree 重定基）→ 单 commit
//   → ref 更新；冲突 → 以新 head 重建重试 ≤2。N 帧序列 = N+4 请求 / 1 commit。
// ---------------------------------------------------------------------------

/** 当前分支 head commit sha（树/提交的基点） */
export async function ghGetHeadCommit(cfg: GithubConfig, budget?: SubrequestBudget): Promise<string> {
  const b = budget ?? new SubrequestBudget(8)
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`
  let res: Response
  try {
    res = await ghFetch(cfg, url, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }, b)
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `ref GET failed: ${String(e)}`)
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
  }
  if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
  if (!res.ok) throw new GithubError('GITHUB_UNEXPECTED', `ref GET status ${res.status}`)
  const body = (await res.json()) as { object?: { sha?: string } }
  if (!body.object?.sha) throw new GithubError('GITHUB_UNEXPECTED', 'ref GET missing object sha')
  return body.object.sha
}

/**
 * 上传单个 blob（幂等：同内容 GitHub 返回同 sha）。
 * 校验响应 sha === 本地预计算 sha（H3：与 ghPutFile 同级的内容一致性要求）。
 */
export async function ghPutBlob(
  cfg: GithubConfig,
  bytes: Uint8Array,
  expectedSha: string,
  budget?: SubrequestBudget,
): Promise<void> {
  const b = budget ?? new SubrequestBudget(8)
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/git/blobs`
  let res: Response
  try {
    res = await ghFetch(
      cfg,
      url,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ content: bytesToBase64(bytes), encoding: 'base64' }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `blob POST failed: ${String(e)}`)
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
  }
  if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
  if (!res.ok) {
    if (res.status >= 500 && !budget) {
      // 独立调用（非批内）时按重试矩阵退避重试 ≤3
      await sleep(500)
      return ghPutBlob(cfg, bytes, expectedSha, b)
    }
    throw new GithubError('GITHUB_UNEXPECTED', `blob POST status ${res.status}`)
  }
  const body = (await res.json()) as { sha?: string }
  if (body.sha !== expectedSha) {
    throw new GithubError('GITHUB_PATH_CONFLICT', `blob sha mismatch: got ${body.sha}, expected ${expectedSha}`)
  }
}

export interface TreeEntry {
  path: string
  sha: string
}

/**
 * 以 head 为基提交一棵树并更新分支（一次 commit）。
 * - base_tree = head commit 的 tree（冲突时调用方重取 head 重试 ≤2）
 * - 重名路径覆盖 base_tree 既有条目（新建/更新统一）；删除走 ghRemoveDir。
 */
export async function ghCommitTree(
  cfg: GithubConfig,
  headCommit: string,
  entries: TreeEntry[],
  message: string,
  budget?: SubrequestBudget,
): Promise<{ commitSha: string }> {
  const b = budget ?? new SubrequestBudget(8)
  // [1] head commit → tree sha
  let res: Response
  try {
    res = await ghFetch(cfg, `${API}/repos/${cfg.owner}/${cfg.repo}/git/commits/${headCommit}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }, b)
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `commit GET failed: ${String(e)}`)
  }
  if (!res.ok) throw new GithubError('GITHUB_UNEXPECTED', `commit GET status ${res.status}`)
  const commitBody = (await res.json()) as { tree?: { sha?: string } }
  const baseTree = commitBody.tree?.sha
  if (!baseTree) throw new GithubError('GITHUB_UNEXPECTED', 'commit GET missing tree sha')

  // [2] 建 tree（base_tree 重定基；嵌套路径自动展开）
  let treeRes: Response
  try {
    treeRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/trees`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({
          base_tree: baseTree,
          tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
        }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `tree POST failed: ${String(e)}`)
  }
  if (treeRes.status === 403 && treeRes.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
  }
  if (treeRes.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
  if (!treeRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `tree POST status ${treeRes.status}`)
  const treeBody = (await treeRes.json()) as { sha?: string }
  if (!treeBody.sha) throw new GithubError('GITHUB_UNEXPECTED', 'tree POST missing sha')

  // [3] commit
  let commitRes: Response
  try {
    commitRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/commits`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ message, tree: treeBody.sha, parents: [headCommit] }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `commit POST failed: ${String(e)}`)
  }
  if (!commitRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `commit POST status ${commitRes.status}`)
  const newCommit = (await commitRes.json()) as { sha?: string }
  if (!newCommit.sha) throw new GithubError('GITHUB_UNEXPECTED', 'commit POST missing sha')

  // [4] ref 更新（force=false；前移冲突由调用方重取 head 重试）
  let refRes: Response
  try {
    refRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${cfg.branch}`,
      {
        method: 'PATCH',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `ref PATCH failed: ${String(e)}`)
  }
  if (refRes.status === 409 || refRes.status === 422) {
    throw new GithubError('GITHUB_PATH_CONFLICT', `ref update conflict: ${refRes.status}`)
  }
  if (!refRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `ref PATCH status ${refRes.status}`)
  return { commitSha: newCommit.sha }
}

/** 带冲突重试的完整提交（Gate §G3：ref 冲突 → 重取 head 重建 ≤2） */
export async function withTreeCommitRetry(
  cfg: GithubConfig,
  entries: TreeEntry[],
  message: string,
): Promise<{ commitSha: string }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = new SubrequestBudget(8 + entries.length)
    try {
      const head = await ghGetHeadCommit(cfg, b)
      return await ghCommitTree(cfg, head, entries, message, b)
    } catch (e) {
      lastErr = e
      if (e instanceof GithubError && e.code === 'GITHUB_PATH_CONFLICT' && attempt < 2) {
        await sleep(500 * (attempt + 1))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

/** 删除型 tree 提交（sha:null 删除条目；相对 base_tree 删除任意嵌套路径） */
async function ghCommitTreeDeletes(
  cfg: GithubConfig,
  headCommit: string,
  deletePaths: string[],
  message: string,
  b: SubrequestBudget,
): Promise<string> {
  // [1] head commit → tree sha
  let res: Response
  try {
    res = await ghFetch(cfg, `${API}/repos/${cfg.owner}/${cfg.repo}/git/commits/${headCommit}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }, b)
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `commit GET failed: ${String(e)}`)
  }
  if (!res.ok) throw new GithubError('GITHUB_UNEXPECTED', `commit GET status ${res.status}`)
  const commitBody = (await res.json()) as { tree?: { sha?: string } }
  const baseTree = commitBody.tree?.sha
  if (!baseTree) throw new GithubError('GITHUB_UNEXPECTED', 'commit GET missing tree sha')

  // [2] sha:null 删除条目
  let treeRes: Response
  try {
    treeRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/trees`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({
          base_tree: baseTree,
          tree: deletePaths.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
        }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `tree POST (delete) failed: ${String(e)}`)
  }
  if (!treeRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `tree POST (delete) status ${treeRes.status}`)
  const treeBody = (await treeRes.json()) as { sha?: string }
  if (!treeBody.sha) throw new GithubError('GITHUB_UNEXPECTED', 'tree POST (delete) missing sha')

  // [3] commit
  let commitRes: Response
  try {
    commitRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/commits`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ message, tree: treeBody.sha, parents: [headCommit] }),
      },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `commit POST (delete) failed: ${String(e)}`)
  }
  if (!commitRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `commit POST (delete) status ${commitRes.status}`)
  const newCommit = (await commitRes.json()) as { sha?: string }
  if (!newCommit.sha) throw new GithubError('GITHUB_UNEXPECTED', 'commit POST (delete) missing sha')

  // [4] ref
  let refRes: Response
  try {
    refRes = await ghFetch(
      cfg,
      `${API}/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${cfg.branch}`,
      { method: 'PATCH', headers: { Accept: 'application/vnd.github+json' }, body: JSON.stringify({ sha: newCommit.sha, force: false }) },
      b,
    )
  } catch (e) {
    throw new GithubError('GITHUB_NETWORK', `ref PATCH (delete) failed: ${String(e)}`)
  }
  if (refRes.status === 409 || refRes.status === 422) {
    throw new GithubError('GITHUB_PATH_CONFLICT', `ref update conflict: ${refRes.status}`)
  }
  if (!refRes.ok) throw new GithubError('GITHUB_UNEXPECTED', `ref PATCH (delete) status ${refRes.status}`)
  return newCommit.sha
}

/**
 * 删除整个目录（一 tree + 一 commit；Gate §G3 回滚语义）。
 * 目录清单来自 Contents API GET（≤1000 条足够：单序列 ≤360 帧）。
 * 404 = 目标态已达 → 成功（幂等，同 ghDeleteFile）。
 */
export async function ghRemoveDir(
  cfg: GithubConfig,
  dirPath: string,
  message: string,
): Promise<{ removed: number; commitSha: string | null }> {
  const b = new SubrequestBudget(16)
  let listing: Array<{ path: string }> = []
  {
    let res: Response
    try {
      res = await ghFetch(cfg, `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${dirPath}?ref=${cfg.branch}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } }, b)
    } catch (e) {
      throw new GithubError('GITHUB_NETWORK', `contents dir GET failed: ${String(e)}`)
    }
    if (res.status === 404) return { removed: 0, commitSha: null }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GithubError('GITHUB_RATE_LIMITED', 'GitHub rate limit exhausted')
    }
    if (res.status === 401) throw new GithubError('GITHUB_AUTH_FAILED', 'GitHub token rejected')
    if (!res.ok) throw new GithubError('GITHUB_UNEXPECTED', `contents dir GET status ${res.status}`)
    const body = (await res.json()) as Array<{ path?: string }>
    listing = (body ?? []).filter((f): f is { path: string } => !!f.path)
  }
  if (listing.length === 0) return { removed: 0, commitSha: null }
  const head = await ghGetHeadCommit(cfg, b)
  let commitSha: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      commitSha = await ghCommitTreeDeletes(cfg, head, listing.map((f) => f.path), message, b)
      break
    } catch (e) {
      if (e instanceof GithubError && e.code === 'GITHUB_PATH_CONFLICT' && attempt < 2) {
        await sleep(500 * (attempt + 1))
        continue
      }
      throw e
    }
  }
  return { removed: listing.length, commitSha }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
