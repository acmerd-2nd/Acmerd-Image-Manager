#!/usr/bin/env node
/**
 * V1.1 Phase B (PB-1) — dry-run 全矩阵验证（Gate 04 §10 Q5 Owner 裁决）
 * 矩阵: Upload → sha 校验 → 覆盖/冲突重试 → DELETE 幂等 → HEAD → raw 可达
 *       （e2e 模式补: Worker 端点全链路 + 租约 + 四态可见性 + 下载守卫）
 *
 * 两种模式:
 *   direct（默认）—— 仅对独立 private 演练仓库做 GitHub API 矩阵，零 DB 触碰。
 *   --e2e         —— 对已部署 Worker 跑全链路（上传/删除走生产 DB，见下方守卫）。
 *
 * 守卫（缺一即退出，绝不半心半意运行）:
 *   direct: DRYRUN_GITHUB_TOKEN(或 GITHUB_TOKEN) + DRYRUN_OWNER + DRYRUN_REPO
 *           + DRYRUN_CONFIRM=yes（显式确认目标为演练仓库，非生产 Image Repository）
 *   e2e:    上述全部 + DRYRUN_E2E_CONFIRM=yes
 *           （e2e 会在 Worker 所连 DB 创建/删除一个 draft 测试 Asset —— 生产 DB 写入，
 *             属 Owner 明确授权范围；不 publish，故下载 302/ZIP 实测需另行授权发布，
 *             本脚本改为断言"未发布 github 图下载必须 404"的可见性守卫）
 *
 * 用法:
 *   node scripts/v11-phase-b-dryrun.mjs            # direct 矩阵
 *   node scripts/v11-phase-b-dryrun.mjs --e2e      # Worker 全链路
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// env 加载（.env 与 wrangler.toml [vars]，凭据绝不回显）
// ---------------------------------------------------------------------------
function loadDotEnv() {
  try {
    const t = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  } catch { /* .env 不存在则全部依赖外部环境 */ }
  try {
    const w = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    for (const m of w.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/gm)) {
      if (m[1].startsWith('SUPABASE') && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  } catch { /* wrangler.toml 不存在 */ }
}
loadDotEnv()

const TOKEN = process.env.DRYRUN_GITHUB_TOKEN || process.env.GITHUB_TOKEN
const OWNER = process.env.DRYRUN_OWNER
const REPO = process.env.DRYRUN_REPO
const BRANCH = process.env.DRYRUN_BRANCH || 'main'
const API = 'https://api.github.com'
const E2E = process.argv.includes('--e2e')

const results = []
let passCount = 0
function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  if (cond) passCount++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
function die(msg) {
  console.error(`ABORT: ${msg}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// GitHub helpers（与 worker/github.ts 同语义的 node 侧对偶实现）
// ---------------------------------------------------------------------------
function ghHeaders(accept) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'acmerd-image-manager-dryrun',
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gh(url, init) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(url, { ...init, headers: { ...ghHeaders(String(init?.headers?.['Accept'] ?? 'application/vnd.github+json')), ...(init?.headers ?? {}) } })
    } catch (e) {
      lastErr = e
      await sleep(500 * 2 ** i)
    }
  }
  throw lastErr
}

async function ghGetMeta(sourcePath) {
  const res = await gh(`${API}/repos/${OWNER}/${REPO}/contents/${sourcePath}?ref=${BRANCH}`, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github.object+json' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET meta ${sourcePath} → ${res.status}`)
  const body = await res.json()
  return { sha: body.sha, size: body.size ?? 0 }
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function computeGitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const merged = new Uint8Array(header.length + bytes.length)
  merged.set(header, 0)
  merged.set(bytes, header.length)
  return createHash('sha1').update(merged).digest('hex')
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** PUT 幂等语义（Gate §4）: 409/422 重取 sha 重试 1 次 */
async function ghPutFile(sourcePath, bytes, expectedSha) {
  const url = `${API}/repos/${OWNER}/${REPO}/contents/${sourcePath}`
  let retried = false
  for (;;) {
    const meta = await ghGetMeta(sourcePath)
    const res = await gh(url, {
      method: 'PUT',
      body: JSON.stringify({
        message: `dryrun ${sourcePath} (acmerd-image-manager)`,
        content: bytesToBase64(bytes),
        branch: BRANCH,
        ...(meta ? { sha: meta.sha } : {}),
      }),
    })
    if (res.ok) {
      const body = await res.json()
      return { shaMatch: body.content?.sha === expectedSha, returnedSha: body.content?.sha ?? null }
    }
    if ((res.status === 409 || res.status === 422) && !retried) {
      retried = true
      continue
    }
    throw new Error(`PUT ${sourcePath} → ${res.status}`)
  }
}

async function ghDeleteFile(sourcePath) {
  const url = `${API}/repos/${OWNER}/${REPO}/contents/${sourcePath}`
  let retried = false
  for (;;) {
    const meta = await ghGetMeta(sourcePath)
    if (!meta) return true // 已不存在 = 成功（幂等）
    const res = await gh(url, {
      method: 'DELETE',
      body: JSON.stringify({ message: `dryrun delete ${sourcePath}`, sha: meta.sha, branch: BRANCH }),
    })
    if (res.ok || res.status === 404) return true
    if ((res.status === 409 || res.status === 422) && !retried) {
      retried = true
      continue
    }
    throw new Error(`DELETE ${sourcePath} → ${res.status}`)
  }
}

const rawUrl = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${p}`

// ---------------------------------------------------------------------------
// direct 矩阵布景：确定性字节（8KB 伪随机，可重放）
// ---------------------------------------------------------------------------
const contentV1 = new Uint8Array(8192).map((_, i) => (i * 31 + 7) % 256)
const contentV2 = new Uint8Array(8192).map((_, i) => (i * 17 + 3) % 256)
const shaV1 = await computeGitBlobSha(contentV1)
const shaV2 = await computeGitBlobSha(contentV2)
const PATH = `dryrun/${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}/matrix.bin`

// ===========================================================================
// direct 模式
// ===========================================================================
async function runDirect() {
  if (!TOKEN || !OWNER || !REPO) die('缺少 DRYRUN_GITHUB_TOKEN / DRYRUN_OWNER / DRYRUN_REPO（不回显值）')
  if (process.env.DRYRUN_CONFIRM !== 'yes') {
    die('DRYRUN_CONFIRM=yes 未设置 —— 请确认目标为独立 private 演练仓库（Gate Q5），绝不指向生产 Image Repository')
  }
  console.log(`[mode] direct → repo ${OWNER}/${REPO} @ ${BRANCH}\n`)

  // M0 仓库可达 + token 有效
  const repoRes = await gh(`${API}/repos/${OWNER}/${REPO}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } })
  ok('M0 演练仓库可达且 token 有效', repoRes.ok, repoRes.ok ? `default_branch=${(await repoRes.json()).default_branch}` : `status=${repoRes.status}`)

  // M1 PUT 创建 + response sha 校验
  const put1 = await ghPutFile(PATH, contentV1, shaV1)
  ok('M1 上传创建：response.content.sha === 本地 git blob sha', put1.shaMatch, `returned=${put1.returnedSha}`)

  // M2 GET 元数据 sha 一致
  const meta1 = await ghGetMeta(PATH)
  ok('M2 GET 元数据 sha 一致', meta1?.sha === shaV1, `size=${meta1?.size}`)

  // M3 同内容重放（幂等更新）
  const put1b = await ghPutFile(PATH, contentV1, shaV1)
  ok('M3 同内容重放：sha 校验仍一致（幂等）', put1b.shaMatch)

  // M4 覆盖为不同内容（409/422 重试语义路径）
  const put2 = await ghPutFile(PATH, contentV2, shaV2)
  ok('M4 覆盖更新：新内容 sha 校验一致', put2.shaMatch)
  const meta2 = await ghGetMeta(PATH)
  ok('M5 GET 复核为新 sha', meta2?.sha === shaV2)

  // M6 raw HEAD 可达 + Content-Length 一致
  //   private 仓库 raw 匿名必 404（生产仓库为 public，Worker 302 依赖该属性）——
  //   布景: private → 带 token 请求；public → 额外断言匿名可达（等价生产行为）
  const isPrivate = (await (await gh(`${API}/repos/${OWNER}/${REPO}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json' } })).json()).private
  const rawHeaders = isPrivate ? { Authorization: `Bearer ${TOKEN}` } : {}
  const raw = await fetch(rawUrl(PATH), { method: 'HEAD', headers: rawHeaders })
  ok('M6 raw HEAD 200', raw.status === 200, `status=${raw.status}${isPrivate ? ' (private repo, authed raw)' : ''}`)
  ok('M7 raw Content-Length === 8192', Number(raw.headers.get('content-length')) === contentV2.length, `len=${raw.headers.get('content-length')}`)
  const rawBytes = new Uint8Array(await (await fetch(rawUrl(PATH), { headers: rawHeaders })).arrayBuffer())
  ok('M8 raw 内容 sha256 === 本地', sha256Hex(rawBytes) === sha256Hex(contentV2))
  if (!isPrivate) {
    const anon = await fetch(rawUrl(PATH), { method: 'HEAD' })
    ok('M8b public 仓库匿名 raw 可达（= 生产 Worker 302 语义）', anon.status === 200, `status=${anon.status}`)
  }

  // M9 DELETE + 幂等重放
  ok('M9 DELETE 成功', await ghDeleteFile(PATH))
  ok('M10 DELETE 重放（对象已不存在）仍成功', await ghDeleteFile(PATH))
  ok('M11 GET 复核 404', (await ghGetMeta(PATH)) === null)

  // M12 过期 sha 语义: 路径已存在且提供的 sha 不匹配 → 422；重试封装重取 sha 恢复
  //   （注: 路径不存在时 GitHub 会无视过期 sha 直接创建——故布景必须先建文件）
  {
    const p2 = `${PATH}.retry`
    await ghPutFile(p2, contentV1, shaV1) // 路径已存在，blob sha = shaV1
    const staleRes = await gh(`${API}/repos/${OWNER}/${REPO}/contents/${p2}`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'stale sha attempt', content: bytesToBase64(contentV2), sha: shaV2, branch: BRANCH }),
    })
    ok('M12a 已存在路径 + 过期 sha PUT → 冲突族（实测 409；Worker 重试矩阵同时覆盖 409/422）', staleRes.status === 409 || staleRes.status === 422, `status=${staleRes.status}`)
    const recovered = await ghPutFile(p2, contentV2, shaV2)
    ok('M12b 重试封装（重取 sha）恢复成功', recovered.shaMatch)
    await ghDeleteFile(p2)
  }
}

// ===========================================================================
// e2e 模式（部署 Worker + draft 测试 Asset；绝不 publish）
// ===========================================================================
const PNG_1PX = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

async function runE2E() {
  await runDirect() // GitHub 层矩阵先行
  console.log('\n[mode] e2e —— Worker 全链路（draft 测试 Asset，绝不 publish）')

  if (process.env.DRYRUN_E2E_CONFIRM !== 'yes') {
    die('DRYRUN_E2E_CONFIRM=yes 未设置 —— e2e 将在 Worker 所连 DB 创建/删除 draft 测试 Asset（生产 DB 写入），需 Owner 明确授权')
  }
  const BASE = (process.env.DRYRUN_BASE_URL || '').replace(/\/$/, '')
  if (!BASE) die('缺少 DRYRUN_BASE_URL（如 https://image.acmerd.com 或 http://localhost:8787）')
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) die('缺少 ADMIN_EMAIL / ADMIN_PASSWORD（.env）')
  const SB = process.env.SUPABASE_URL
  const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
  if (!SB || !SB_KEY) die('缺少 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY（.env + wrangler.toml [vars]）')

  // E0 health 存活（github 配置就位与否由 E3 实际上传成功证明——health 不暴露配置细节）
  const health = await (await fetch(`${BASE}/api/health`)).json()
  ok('E0 /api/health 存活', health?.status === 'ok', JSON.stringify(health).slice(0, 100))

  // E1 admin 登录（Supabase password grant）
  const login = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  })
  if (!login.ok) die(`admin 登录失败 status=${login.status}`)
  const jwt = (await login.json()).access_token
  const authHeaders = { apikey: SB_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
  const me = await (await fetch(`${SB}/auth/v1/user`, { headers: authHeaders })).json()
  const adminId = me.id
  ok('E1 admin 登录', !!adminId)

  const slug = `dryrun-${Date.now().toString(36)}`
  const rest = (path, init) => fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...authHeaders, ...(init?.headers ?? {}) } })

  // E2 创建 draft 测试 Asset + 语言（绝不 publish → 产品面零暴露）
  const assetRes = await rest('assets', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: '[dry-run] PB-1 matrix', slug, description: 'PB-1 dry-run 测试资产，脚本自动清理', status: 'draft', created_by: adminId }),
  })
  if (!assetRes.ok) die(`测试 Asset 创建失败 status=${assetRes.status}: ${await assetRes.text()}`)
  const asset = (await assetRes.json())[0]
  const lang = (
    await (
      await rest('asset_languages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ asset_id: asset.id, language_code: 'en', status: 'draft' }),
      })
    ).json()
  )[0]
  ok('E2 draft 测试 Asset/语言就位', !!asset?.id && !!lang?.id, `slug=${slug}`)

  let imageId = null
  let structurallyBlocked = false
  try {
    // E3 Worker github-upload 全链路
    const form = new FormData()
    form.append('file', new File([PNG_1PX], 'dryrun.png', { type: 'image/png' }))
    form.append('asset_language_id', lang.id)
    const upRes = await fetch(`${BASE}/api/admin/images/github-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    })
    const upBody = await upRes.json().catch(() => ({}))

    // 结构性阻塞: 目标库未应用 0009–0014（租约 RPC 不存在）→ e2e 全链路等 Owner 授权迁移后重跑
    if (upRes.status === 503 && upBody?.error?.code === 'db_not_provisioned') {
      structurallyBlocked = true
      ok('E3 结构性 SKIP：目标库未应用 0009-0014（租约 RPC 缺失）——迁移应用后重跑本脚本即全链路', true, 'deferred')
      console.log('\n[e2e] 全链路被 Gate 阻塞：0009-0014 未应用到目标库。direct 矩阵与布景/清理链路已验证。')
    } else {
      ok('E3 Worker 上传 ok + status=ready', upRes.ok && upBody?.status === 'ready', `source_path=${upBody?.source_path}`)
      imageId = upBody?.image_id ?? null

      // E4 路径冻结断言: assets/{asset-uuid}/{langCode}/{filename}
      ok('E4 路径符合冻结规范', typeof upBody?.source_path === 'string' && upBody.source_path === `assets/${asset.id}/en/${upBody.source_path.split('/').pop()}`)

      // E5 raw HEAD 可达
      const raw = await fetch(rawUrl(upBody.source_path), { method: 'HEAD', headers: { Authorization: `Bearer ${TOKEN}` } })
      ok('E5 raw HEAD 200', raw.status === 200, `status=${raw.status}`)

      // E6 行状态断言（admin REST 直查）
      const row = (await (await rest(`images?id=eq.${imageId}&select=provider,source_path,source_sha,status,storage_path`)).json())[0]
      const expectSha = await computeGitBlobSha(PNG_1PX)
      ok('E6 行: provider=github/status=ready/source_sha 一致/storage_path 为空',
         row?.provider === 'github' && row?.status === 'ready' && row?.source_sha === expectSha && row?.storage_path === null)

      // E7 可见性守卫：未认证 → 401（登录软门控）；认证后访问未发布 github 图 → 404（published 双层校验）
      const dlAnon = await fetch(`${BASE}/api/downloads/image/${imageId}`, { redirect: 'manual' })
      ok('E7a 未认证下载 401（登录门）', dlAnon.status === 401, `status=${dlAnon.status}`)
      const dl = await fetch(`${BASE}/api/downloads/image/${imageId}`, { redirect: 'manual', headers: { Authorization: `Bearer ${jwt}` } })
      ok('E7b 认证后未发布图下载 404（可见性守卫）', dl.status === 404, `status=${dl.status}`)

      // E8 四态删除闭环：远端删除成功前不物理删行
      const delRes = await fetch(`${BASE}/api/admin/images/github-delete`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ imageId }),
      })
      ok('E8 Worker 删除 ok', delRes.ok, `status=${delRes.status}`)
      const gone = (await (await rest(`images?id=eq.${imageId}&select=id`)).json())
      ok('E9 删除后 DB 行已移除', Array.isArray(gone) && gone.length === 0)
      ok('E10 GitHub 对象已移除（GET 404）', (await ghGetMeta(upBody.source_path)) === null)
    }
  } finally {
    // 清理: draft Asset 级联清语言/残余行（github 对象已在 E8 闭环删除）
    await rest(`assets?id=eq.${asset.id}`, { method: 'DELETE' })
    const leftover = await (await rest(`assets?id=eq.${asset.id}&select=id`)).json()
    ok(structurallyBlocked ? 'E11 测试 Asset 清理完成（结构跳过路径）' : 'E11 测试 Asset 清理完成', Array.isArray(leftover) && leftover.length === 0)
  }
}

// ---------------------------------------------------------------------------
try {
  if (E2E) await runE2E()
  else await runDirect()
} catch (e) {
  die(e instanceof Error ? e.message : String(e))
}
const failCount = results.length - passCount
console.log(`\nresult: ${passCount} PASS / ${failCount} FAIL`)
process.exit(failCount > 0 ? 1 : 0)
