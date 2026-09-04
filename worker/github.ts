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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
