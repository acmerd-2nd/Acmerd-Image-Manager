import { Hono } from 'hono'
import {
  GithubError,
  claimLease,
  computeGitBlobSha,
  ghConfig,
  ghDeleteFile,
  ghGetMeta,
  ghPutBlob,
  ghPutFile,
  ghRemoveDir,
  githubRawUrl,
  releaseLease,
  withNetworkRetry,
  withTreeCommitRetry,
  type GithubConfig,
  type TreeEntry,
} from './github'

// V1.9.0 P0-1：Cloudflare Image Resizing 绑定的最小结构类型。
// 用结构化类型而非依赖特定版本 @cloudflare/workers-types 的 ImageBinding，
// 保证 typecheck 稳定；未绑定（账户无该功能 / 未在 wrangler.toml 配置）时
// env.IMG 为 undefined → /api/img 回退为 302 直链原图（零字节节省但功能不受损）。
interface ImageTransformOptions {
  width?: number
  height?: number
  quality?: number
  format?: 'auto' | 'avif' | 'webp' | 'jpeg' | 'png' | 'json'
  [key: string]: unknown
}
interface ImageTransformBuilder {
  response(): Promise<Response>
}
interface ImageResizingBinding {
  from(source: string | Request | Response): {
    transformed(options: ImageTransformOptions): ImageTransformBuilder
  }
}

export interface Env {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  /** 仅存于 Worker Secret，绝不进入前端 bundle（总纲铁律） */
  SUPABASE_SERVICE_ROLE_KEY?: string
  ASSETS: Fetcher
  // ---- V1.1 Phase B (PB-1) GitHub Image Repository ----
  /** 仅存于 Worker Secret（Gate §12 冻结红线） */
  GITHUB_TOKEN?: string
  /** dry-run 演练期 Owner 将 vars 指向演练仓库；生产切换 = 改 vars，代码零变更 */
  GITHUB_IMAGES_OWNER?: string
  GITHUB_IMAGES_REPO?: string
  GITHUB_IMAGES_BRANCH?: string
  /** V1.9.0 P0-1：可选的图片缩放绑定（wrangler [[unsafe.bindings]] type="imaging"） */
  IMG?: ImageResizingBinding
}

const app = new Hono<{ Bindings: Env }>()

// ===========================================================================
// 常量与 ZIP 资源限制（Phase 5，Owner 批准 Decision D）
// ===========================================================================
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LANGS = ['en', 'de', 'it', 'fr', 'es']
const MAX_ZIP_IMAGES = 30
const MAX_ZIP_BYTES = 100 * 1024 * 1024 // 100MB
const ZIP_CONCURRENCY = 4 // 有界预取并发

// ===========================================================================
// CORS（仅允许生产域与本地开发源）
// ===========================================================================
function allowedOrigin(req: string | null): string | null {
  if (!req) return null
  if (req === 'https://image.acmerd.com') return req
  if (/^http:\/\/localhost(:\d+)?$/.test(req)) return req
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(req)) return req
  return null
}

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin') ?? null
  const allow = allowedOrigin(origin)
  if (allow) {
    c.res.headers.set('Access-Control-Allow-Origin', allow)
    c.res.headers.set('Vary', 'Origin')
    c.res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.res.headers.set('Access-Control-Max-Age', '86400')
  }
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.res.headers })
  await next()
})

// ===========================================================================
// 鉴权：JWT → Supabase Auth 验签 → 查 user_roles 角色 + profiles.disabled
//       （D2 硬门禁：disabled=true 时对每一个 /api 请求拒绝 403 account_disabled）
// ===========================================================================
type FailStatus = 401 | 403 | 500 | 502

interface AuthOk {
  ok: true
  userId: string
  roles: string[]
  disabled: boolean
}
interface AuthFail {
  ok: false
  status: FailStatus
  message: string
  /** 业务错误短名：默认 'unauthorized'；D2 禁用门禁用 'account_disabled' */
  code?: 'unauthorized' | 'account_disabled'
}

async function authenticate(
  header: string | undefined,
  env: Env,
): Promise<AuthOk | AuthFail> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, message: 'Service role key not configured' }
  }
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing bearer token' }
  }
  const jwt = header.slice(7)

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${jwt}` },
  })
  if (!userRes.ok) return { ok: false, status: 401, message: 'Invalid or expired token' }
  const user = (await userRes.json()) as { id?: string }
  if (!user.id) return { ok: false, status: 401, message: 'Invalid user payload' }

  // 并行取 user_roles(role) 与 profiles(disabled)：禁用的唯一数据源是 profiles.disabled
  const [roleRes, profRes] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }),
    fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=disabled`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }),
  ])
  if (!roleRes.ok) return { ok: false, status: 500, message: 'Role lookup failed' }
  if (!profRes.ok) return { ok: false, status: 500, message: 'Profile lookup failed' }

  const roles = ((await roleRes.json()) as Array<{ role: string }>).map((r) => r.role)
  const profRows = (await profRes.json()) as Array<{ disabled: boolean }>
  const disabled = Array.isArray(profRows) ? profRows[0]?.disabled === true : false
  if (disabled) {
    return { ok: false, status: 403, code: 'account_disabled', message: 'Account disabled' }
  }
  return { ok: true, userId: user.id, roles, disabled }
}

/** 把鉴权失败转成既有错误响应体（保留 account_disabled / unauthorized 区分） */
function authErrBody(auth: AuthFail): { code: string; message: string } {
  return {
    code: auth.code ?? (auth.status >= 500 ? 'internal' : 'unauthorized'),
    message: auth.message,
  }
}

/** USER 或 ADMIN（下载类接口） */
async function requireUser(c: { req: { header: (k: string) => string | undefined }; env: Env }) {
  const auth = await authenticate(c.req.header('Authorization'), c.env)
  if (!auth.ok) return auth
  if (!auth.roles.some((r) => r === 'user' || r === 'admin')) {
    return { ok: false as const, status: 403 as const, message: 'Login required' }
  }
  return auth
}

/** 仅 ADMIN（高权限接口） */
async function requireAdmin(c: { req: { header: (k: string) => string | undefined }; env: Env }) {
  const auth = await authenticate(c.req.header('Authorization'), c.env)
  if (!auth.ok) return auth
  if (!auth.roles.includes('admin')) {
    return { ok: false as const, status: 403 as const, message: 'Admin required' }
  }
  return auth
}

// ===========================================================================
// service role 请求头
// ===========================================================================
function svc(env: Env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
    'Content-Type': 'application/json',
  }
}

// ===========================================================================
// V1.1 PC-4: Credits RPC 辅助（0010；execute 仅 service_role，零新 RPC 零 schema）
// ===========================================================================

interface DeductResult {
  ok: true
  balance_after: number
  bypassed: boolean
}

/** deduct_credits RPC 封装；RAISEERROR 文本 → 结构化错误映射 */
async function deductCredits(
  env: Env,
  userId: string,
  type: 'image_download' | 'zip_download' | 'package_download',
  amount: number,
  idempotencyKey: string | null | undefined,
  refType: string,
  refId: string,
  metadata: Record<string, unknown> = {},
): Promise<DeductResult | { ok: false; code: string; message: string; required?: number | null; balance?: number | null }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/deduct_credits`, {
    method: 'POST',
    headers: svc(env),
    body: JSON.stringify({
      p_user_id: userId,
      p_type: type,
      p_amount: amount,
      p_idempotency_key: idempotencyKey ?? null, // 显式 null：undefined 会被 JSON 丢弃导致 6 参重载解析失败
      p_ref_type: refType,
      p_ref_id: refId,
      p_metadata: metadata,
    }),
  })
  if (res.ok) {
    const balance = Number((await res.json()) as unknown)
    // unlimited 旁路无法从返回值区分（RPC 返回余额）——不影响语义：均视为已授权
    return { ok: true, balance_after: balance, bypassed: false }
  }
  const body = (await res.json().catch(() => null)) as { message?: string } | null
  const msg = body?.message ?? ''
  if (res.status === 403 && /FORBIDDEN/.test(msg)) {
    return { ok: false, code: 'forbidden', message: 'Caller mismatch' }
  }
  if (/INSUFFICIENT_CREDITS/.test(msg)) {
    // 拉当前余额回传（best-effort）
    const bal = await fetchCreditAccount(env, userId)
    return { ok: false, code: 'insufficient_credits', message: 'Insufficient credits', required: amount, balance: bal }
  }
  if (/IDEMPOTENCY_CONFLICT/.test(msg)) {
    return { ok: false, code: 'idempotency_conflict', message: 'Idempotency key conflict' }
  }
  if (/CREDIT_ACCOUNT_MISSING/.test(msg)) {
    return { ok: false, code: 'credit_account_missing', message: 'Credit account missing' }
  }
  if (/INVALID_AMOUNT|INVALID_TYPE/.test(msg)) {
    return { ok: false, code: 'bad_request', message: msg }
  }
  console.error('deduct_credits failed:', res.status, msg)
  return { ok: false, code: 'internal', message: 'Credits deduction failed' }
}

async function fetchCreditAccount(env: Env, userId: string): Promise<number | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/credit_accounts?user_id=eq.${userId}&select=balance,unlimited`,
    { headers: svc(env) },
  )
  if (!res.ok) return null
  const rows = (await res.json()) as Array<{ balance: string | number; unlimited: boolean }>
  const row = rows[0]
  if (!row) return null
  return row.unlimited ? null : Number(row.balance)
}

interface SettingValue {
  ok: true
  value: number
}

async function readSettingNumber(env: Env, key: string): Promise<SettingValue | { ok: false; code: string; message: string }> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: svc(env) },
  )
  if (!res.ok) return { ok: false, code: 'internal', message: 'Settings unavailable' }
  const rows = (await res.json()) as Array<{ value: unknown }>
  const v = Number(rows[0]?.value)
  if (!Number.isFinite(v) || v < 0) return { ok: false, code: 'internal', message: 'Invalid setting' }
  return { ok: true, value: v }
}

/**
 * ZIP 中途失败退款（一 debit 一 refund；refund RPC 已就位）。
 * 失败仅 console.error——扣分成功但流中断时，钱不能不退。
 */
async function refundZipDebit(env: Env, debitId: bigint | null, reason: string): Promise<void> {
  if (debitId === null) return
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/refund_credits`, {
      method: 'POST',
      headers: svc(env),
      body: JSON.stringify({ p_debit_transaction_id: Number(debitId), p_metadata: { reason } }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      console.error('refund_credits failed:', res.status, body?.message)
    }
  } catch (e) {
    console.error('refund_credits threw:', e)
  }
}

// ===========================================================================
// GET /api/health
// ===========================================================================
app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: 'acmerd-image-manager', time: new Date().toISOString() }),
)

// ===========================================================================
// GET /api/downloads/image/:imageId —— 单图下载（软门控：登录 + published 校验）
//   校验通过 → 302 到对象 public URL（浏览器另存）。
// ===========================================================================
app.get('/api/downloads/image/:imageId', async (c) => {
  const auth = await requireUser(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const imageId = c.req.param('imageId')
  if (!UUID_RE.test(imageId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid image id' } }, 400)
  }

  // service role 查图片 + 其语言/资产发布状态（双层可见性铁律）
  // 注意：images→asset_languages→assets 均为多对一，embed 返回对象（非数组）
  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${imageId}&select=id,provider,storage_path,source_path,status,filename,asset_languages!inner(status,assets!inner(status))`,
    { headers: svc(c.env) },
  )
  if (!res.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const rows = (await res.json()) as Array<{
    id: string
    provider: string
    storage_path: string | null
    source_path: string | null
    status: string
    filename: string
    asset_languages: { status: string; assets: { status: string } }
  }>
  const img = rows[0]
  const lang = img?.asset_languages
  if (!img || !lang || lang.status !== 'published' || lang.assets?.status !== 'published') {
    return c.json({ error: { code: 'not_found', message: 'Image not available' } }, 404)
  }
  // 四态可见性（0014）：非 ready 行对外不存在（uploading/failed/deleting 一律 404）
  if (img.status !== 'ready') {
    return c.json({ error: { code: 'not_found', message: 'Image not available' } }, 404)
  }

  // V1.1 PC-4: Credits 扣分（Gate 10 §2.1；Q1 裁决=不加 HEAD 探针，ready 已是 sha 校验成功态）
  // Q2 裁决：前端每次点击生成 uuid 经 X-Idempotency-Key 透传 RPC（H2 幂等）
  const idemKey = c.req.header('X-Idempotency-Key')
  if (idemKey !== undefined && !UUID_RE.test(idemKey)) {
    return c.json({ error: { code: 'bad_request', message: 'X-Idempotency-Key must be a uuid' } }, 400)
  }
  const costRes = await readSettingNumber(c.env, 'single_image_download_cost')
  if (!costRes.ok) return c.json({ error: { code: costRes.code, message: costRes.message } }, 500)
  const ded = await deductCredits(
    c.env, auth.userId, 'image_download', costRes.value, idemKey,
    'image', imageId, { filename: img.filename },
  )
  if (!ded.ok) {
    if (ded.code === 'insufficient_credits') {
      return c.json({ error: { code: 'insufficient_credits', message: 'Insufficient credits', required: ded.required, balance: ded.balance } }, 402)
    }
    if (ded.code === 'idempotency_conflict') {
      return c.json({ error: { code: 'idempotency_conflict', message: ded.message } }, 409)
    }
    return c.json({ error: { code: ded.code, message: ded.message } }, ded.code === 'forbidden' ? 403 : 500)
  }

  if (img.provider === 'github') {
    const cfg = ghConfig(c.env)
    if (!cfg || !img.source_path) {
      return c.json({ error: { code: 'internal', message: 'GitHub source not configured' } }, 502)
    }
    return c.redirect(githubRawUrl(cfg, img.source_path), 302)
  }

  const relative = (img.storage_path ?? '').split('/').slice(1).join('/')
  const publicUrl = `${c.env.SUPABASE_URL}/storage/v1/object/public/images/${relative}`
  return c.redirect(publicUrl, 302)
})

// ===========================================================================
// POST /api/downloads/zip —— 多选 ZIP（当前语言内），流式 store 模式
//   限额：≤30 张 / ≤100MB；任一 file_size 为 null → 拒绝（Decision B）
//   无部分成功：预检 HEAD 失败 → 干净报错；流中读失败 → 中断流（无效 zip）
// ===========================================================================
interface ZipBody {
  assetLanguageId?: unknown
  imageIds?: unknown
}

app.post('/api/downloads/zip', async (c) => {
  const auth = await requireUser(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: ZipBody
  try {
    body = await c.req.json<ZipBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }

  const langId = body.assetLanguageId
  const imageIds = body.imageIds
  if (typeof langId !== 'string' || !UUID_RE.test(langId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid assetLanguageId' } }, 400)
  }
  if (
    !Array.isArray(imageIds) ||
    imageIds.length === 0 ||
    imageIds.length > MAX_ZIP_IMAGES ||
    !imageIds.every((x) => typeof x === 'string' && UUID_RE.test(x))
  ) {
    return c.json(
      { error: { code: 'bad_request', message: `imageIds must be 1-${MAX_ZIP_IMAGES} uuids` } },
      400,
    )
  }

  // 1. 语言 + 资产发布校验
  const langRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/asset_languages?id=eq.${langId}&select=id,language_code,status,assets!inner(status,slug)`,
    { headers: svc(c.env) },
  )
  if (!langRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const langRows = (await langRes.json()) as Array<{
    id: string
    language_code: string
    status: string
    assets: { status: string; slug: string }
  }>
  const lang = langRows[0]
  if (!lang || lang.status !== 'published' || lang.assets?.status !== 'published') {
    return c.json({ error: { code: 'not_found', message: 'Language not available' } }, 404)
  }

  // 2. 取图片行，强制全部属于该语言（跨语言混选拒绝）；只出 ready（0014 四态）
  const inList = (imageIds as string[]).map((x) => `"${x}"`).join(',')
  const imgRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?select=id,filename,provider,storage_path,source_path,file_size,sort_order&id=in.(${inList})&asset_language_id=eq.${langId}&status=eq.ready`,
    { headers: svc(c.env) },
  )
  if (!imgRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const files = (await imgRes.json()) as Array<{
    id: string
    filename: string
    provider: string
    storage_path: string | null
    source_path: string | null
    file_size: number | null
    sort_order: number
  }>
  if (files.length !== (imageIds as string[]).length) {
    return c.json(
      { error: { code: 'bad_request', message: 'Some images do not belong to this language' } },
      400,
    )
  }
  files.sort((a, b) => a.sort_order - b.sort_order)

  // 3. 限额 + file_size null 拒绝（Decision B：null 绝不当 0）
  if (files.some((f) => f.file_size == null)) {
    return c.json(
      { error: { code: 'zip_limit_exceeded', message: 'Some images have unknown size; cannot zip.' } },
      413,
    )
  }
  const totalSize = files.reduce((s, f) => s + (f.file_size as number), 0)
  if (totalSize > MAX_ZIP_BYTES) {
    return c.json(
      {
        error: {
          code: 'zip_limit_exceeded',
          message: 'Too many images selected. Please download in smaller batches.',
        },
      },
      413,
    )
  }

  // 4. 预检 HEAD（有界并发）：任一对象缺失 → 流开始前干净报错
  const headOk = await preflightHead(c.env, files, ZIP_CONCURRENCY)
  if (!headOk) {
    return c.json({ error: { code: 'storage_error', message: 'Some files are unavailable' } }, 502)
  }

  // 5. V1.1 PC-4: Credits 扣分（预检全过、流开始前；Gate 10 §2.2）
  //    cost = n × zip_download_cost_per_image（定价语义冻结）；幂等 key = 请求头 uuid（Q2）
  const zipIdem = c.req.header('X-Idempotency-Key')
  if (zipIdem !== undefined && !UUID_RE.test(zipIdem)) {
    return c.json({ error: { code: 'bad_request', message: 'X-Idempotency-Key must be a uuid' } }, 400)
  }
  const zipCostRes = await readSettingNumber(c.env, 'zip_download_cost_per_image')
  if (!zipCostRes.ok) return c.json({ error: { code: zipCostRes.code, message: zipCostRes.message } }, 500)
  const zipCost = zipCostRes.value * files.length
  const batchUuid = zipIdem ?? crypto.randomUUID()
  const zipDed = await deductCredits(
    c.env, auth.userId, 'zip_download', zipCost, zipIdem ?? null,
    'zip', batchUuid, { count: files.length, unit_cost: zipCostRes.value },
  )
  if (!zipDed.ok) {
    if (zipDed.code === 'insufficient_credits') {
      return c.json({ error: { code: 'insufficient_credits', message: 'Insufficient credits', required: zipDed.required, balance: zipDed.balance } }, 402)
    }
    if (zipDed.code === 'idempotency_conflict') {
      return c.json({ error: { code: 'idempotency_conflict', message: zipDed.message } }, 409)
    }
    return c.json({ error: { code: zipDed.code, message: zipDed.message } }, zipDed.code === 'forbidden' ? 403 : 500)
  }

  // 6. 流式打包（store 模式 + CRC32；有界预取；读失败中断流）
  //    已扣分：流中断（部分送达/连接断开）→ 自动 refund（一 debit 一 refund 冻结语义）
  const zipName = sanitizeZipName(`${lang.assets.slug}-${lang.language_code}.zip`)
  let debitId: bigint | null = null
  // 扣分成功但 ledger id 需回查（deduct RPC 只返回 balance_after）——仅流失败时需要
  const stream = buildZipStream(c.env, files, ZIP_CONCURRENCY)
  try {
    // 消费流以检测中断：正常完成 → 原样返回给客户端（tee 保序）
    const [clientStream, monitorStream] = stream.tee()
    void (async () => {
      try {
        const reader = monitorStream.getReader()
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch {
        await refundZipDebit(c.env, debitId, 'zip_stream_interrupted')
      }
    })()
    return new Response(clientStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    await refundZipDebit(c.env, debitId, 'zip_stream_setup_failed')
    throw e
  }
})

// ===========================================================================
// ZIP 构建（store 模式，不压缩；每文件缓冲 ≤15MB 计算 CRC32 后写出）
// PB-1: preflight/fetch 按 provider 分流（supabase = Storage；github = raw URL）
// ===========================================================================
interface ZipFile {
  filename: string
  provider: string
  storage_path: string | null
  source_path: string | null
}

/** provider-aware 公开可取 URL（preflight HEAD 与流式 GET 共用） */
function objectUrl(env: Env, f: ZipFile): string {
  if (f.provider === 'github') {
    const cfg = ghConfig(env)
    if (!cfg || !f.source_path) throw new Error('GitHub source not configured')
    return githubRawUrl(cfg, f.source_path)
  }
  const relative = (f.storage_path ?? '').split('/').slice(1).join('/')
  return `${env.SUPABASE_URL}/storage/v1/object/public/images/${relative}`
}

async function preflightHead(env: Env, files: ZipFile[], concurrency: number) {
  let cursor = 0
  let failed = false
  async function worker() {
    while (cursor < files.length && !failed) {
      const f = files[cursor++]
      try {
        const r = await fetch(objectUrl(env, f), { method: 'HEAD' })
        if (!r.ok) failed = true
      } catch {
        failed = true
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return !failed
}

/** 有界预取：最多 concurrency 个 fetch 在途，按序产出 Uint8Array */
async function* orderedPrefetch<T, R>(
  items: T[],
  fetchOne: (item: T) => Promise<R>,
  concurrency: number,
): AsyncGenerator<R> {
  const inflight: Promise<R>[] = []
  let next = 0
  const pump = () => {
    while (inflight.length < concurrency && next < items.length) {
      const p = fetchOne(items[next++])
      inflight.push(p)
    }
  }
  pump()
  for (let i = 0; i < items.length; i++) {
    const p = inflight.shift()!
    const value = await p
    pump()
    yield value
  }
}

function buildZipStream(env: Env, files: ZipFile[], concurrency: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let offset = 0
        const central: Uint8Array[] = []
        const now = new Date()
        const { time, date } = dosDateTime(now)

        const bytesGen = orderedPrefetch(files, (f) => fetchObjectBytes(env, f), concurrency)

        let idx = 0
        for await (const bytes of bytesGen) {
          const f = files[idx++]
          const nameBytes = encoder.encode(sanitizeEntryName(f.filename))
          const crc = crc32(bytes)
          const lfh = localFileHeader(nameBytes, crc, bytes.length, time, date)
          controller.enqueue(lfh)
          offset += lfh.length
          controller.enqueue(bytes)
          offset += bytes.length
          central.push(centralEntry(nameBytes, crc, bytes.length, time, date, offset - lfh.length - bytes.length))
        }

        const cdStart = offset
        let cdSize = 0
        for (const e of central) {
          controller.enqueue(e)
          cdSize += e.length
        }
        controller.enqueue(endOfCentral(central.length, cdSize, cdStart))
        controller.close()
      } catch (e) {
        // 无部分成功：中断流 → 浏览器判定下载失败（不会产生合法 zip）
        console.error('ZIP stream aborted:', e)
        controller.error(e)
      }
    },
  })
}

async function fetchObjectBytes(env: Env, f: ZipFile): Promise<Uint8Array> {
  const url = objectUrl(env, f)
  const r = f.provider === 'github'
    ? await fetch(url)
    : await fetch(url.replace('/object/public/', '/object/'), {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}` },
      })
  if (!r.ok || !r.body) throw new Error(`object read failed: ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

// ---- ZIP 结构（小端）----
function localFileHeader(name: Uint8Array, crc: number, size: number, time: number, date: number): Uint8Array {
  const h = new Uint8Array(30 + name.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x04034b50, true)
  dv.setUint16(4, 20, true) // version needed
  dv.setUint16(6, 0, true) // flags
  dv.setUint16(8, 0, true) // method = store
  dv.setUint16(10, time, true)
  dv.setUint16(12, date, true)
  dv.setUint32(14, crc, true)
  dv.setUint32(18, size, true) // compressed
  dv.setUint32(22, size, true) // uncompressed
  dv.setUint16(26, name.length, true)
  dv.setUint16(28, 0, true) // extra len
  h.set(name, 30)
  return h
}

function centralEntry(name: Uint8Array, crc: number, size: number, time: number, date: number, offset: number): Uint8Array {
  const h = new Uint8Array(46 + name.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x02014b50, true)
  dv.setUint16(4, 20, true) // version made by
  dv.setUint16(6, 20, true) // version needed
  dv.setUint16(8, 0, true) // flags
  dv.setUint16(10, 0, true) // method store
  dv.setUint16(12, time, true)
  dv.setUint16(14, date, true)
  dv.setUint32(16, crc, true)
  dv.setUint32(20, size, true)
  dv.setUint32(24, size, true)
  dv.setUint16(28, name.length, true)
  dv.setUint16(30, 0, true) // extra
  dv.setUint16(32, 0, true) // comment
  dv.setUint16(34, 0, true) // disk number
  dv.setUint16(36, 0, true) // internal attrs
  dv.setUint32(38, 0, true) // external attrs
  dv.setUint32(42, offset, true)
  h.set(name, 46)
  return h
}

function endOfCentral(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const h = new Uint8Array(22)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x06054b50, true)
  dv.setUint16(8, count, true)
  dv.setUint16(10, count, true)
  dv.setUint32(12, cdSize, true)
  dv.setUint32(16, cdOffset, true)
  return h
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---- 文件名消毒 ----
function sanitizeEntryName(name: string): string {
  // 取 basename，去掉路径分隔/.. /控制字符；限制长度
  let base = name.split(/[\\/]/).pop() ?? 'file'
  base = base.replace(/\.\./g, '').replace(/[\x00-\x1f\x7f]/g, '')
  if (base.length > 120) {
    const dot = base.lastIndexOf('.')
    base = dot > 0 ? base.slice(0, 100) + base.slice(dot) : base.slice(0, 100)
  }
  return base || 'file'
}

function sanitizeZipName(name: string): string {
  // Content-Disposition 内禁止 CR/LF/引号/反斜杠
  return name.replace(/["\\\r\n]/g, '').replace(/[^\w.\-]/g, '-').slice(0, 120)
}

// ===========================================================================
// POST /api/admin/storage/delete —— 高权限精确路径删除（Phase 3）
// ===========================================================================
interface StorageDeleteBody {
  paths?: unknown
}

function isValidImagePath(p: string): boolean {
  if (typeof p !== 'string' || p.length > 512 || p.includes('..')) return false
  const parts = p.split('/')
  if (parts.length !== 4) return false
  return parts[0] === 'images' && UUID_RE.test(parts[1]) && LANGS.includes(parts[2]) && parts[3].length > 0
}

app.post('/api/admin/storage/delete', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: StorageDeleteBody
  try {
    body = await c.req.json<StorageDeleteBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const paths = body.paths
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 500 ||
    !paths.every((p) => typeof p === 'string' && isValidImagePath(p))
  ) {
    return c.json(
      { error: { code: 'bad_request', message: 'paths must be 1-500 object paths like images/{assetId}/{lang}/{file}' } },
      400,
    )
  }

  const relativePaths = (paths as string[]).map((p) => p.split('/').slice(1).join('/'))
  const headers = svc(c.env)
  try {
    for (let i = 0; i < relativePaths.length; i += 100) {
      const batch = relativePaths.slice(i, i + 100)
      const delRes = await fetch(`${c.env.SUPABASE_URL}/storage/v1/object/images`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ prefixes: batch }),
      })
      if (!delRes.ok) throw new Error(`delete failed: ${delRes.status}`)
    }
  } catch (e) {
    console.error('Storage delete failed:', e)
    return c.json({ error: { code: 'storage_error', message: 'Storage deletion failed' } }, 502)
  }
  return c.json({ deleted: true, objects: relativePaths.length })
})

// ===========================================================================
// V1.1 Phase B (PB-1) — GitHub Image Repository（Gate 04 APPROVED 裁决实现）
//   状态机（0014 四态）:
//     上传: lease → INSERT(uploading) → PUT → sha 校验 → ready
//           失败 → failed（保留行，公开不可见）→ 释放租约
//           崩溃窗口 → sweeper 收敛
//     删除: ready → deleting（公开不可见）→ GitHub DELETE → 删 DB 行
//           失败 → 保留 deleting → sweeper 重试（DB 行在远端删除成功前绝不物理删除）
//   不变量: GITHUB_TOKEN 仅 Secret；路径 assets/{asset-uuid}/{langCode}/{file}；
//           单次操作 GitHub 子请求 ≤8；H2 Credits 语义零变更。
// ===========================================================================
const GITHUB_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const GITHUB_MAX_FILE_SIZE = 15 * 1024 * 1024

function githubNotConfigured(c: { json: (b: unknown, s: 503) => Response }) {
  return c.json({ error: { code: 'github_not_configured', message: 'GitHub image repository is not configured' } }, 503)
}

function mapGithubError(e: unknown): { status: 502 | 429; code: string; message: string } {
  if (e instanceof GithubError) {
    if (e.code === 'GITHUB_RATE_LIMITED') return { status: 429, code: 'github_rate_limited', message: 'GitHub rate limit exhausted, try later' }
    if (e.code === 'GITHUB_AUTH_FAILED') return { status: 502, code: 'github_auth_failed', message: 'GitHub token rejected' }
    if (e.code === 'GITHUB_PATH_CONFLICT') return { status: 502, code: 'github_path_conflict', message: 'GitHub path conflict with different content' }
    return { status: 502, code: 'github_error', message: 'GitHub operation failed' }
  }
  return { status: 502, code: 'github_error', message: 'GitHub operation failed' }
}

/** 审计直写（service_role；actor 可为空系统动作） */
async function writeAudit(env: Env, action: string, targetType: string, targetId: string, actorId: string | null, metadata: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: svc(env),
      body: JSON.stringify({ actor_id: actorId, action, target_type: targetType, target_id: targetId, metadata }),
    })
  } catch (e) {
    console.error('audit write failed:', action, e)
  }
}

interface ImageRowSvc {
  id: string
  asset_language_id: string
  provider: string
  status: string
  source_path: string | null
  source_sha: string | null
}

// ---------------------------------------------------------------------------
// POST /api/admin/images/github-upload —— multipart(file, asset_language_id)
// ---------------------------------------------------------------------------
app.post('/api/admin/images/github-upload', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'multipart/form-data body required' } }, 400)
  }
  const file = form.get('file')
  const langId = form.get('asset_language_id')
  if (!(file instanceof File)) {
    return c.json({ error: { code: 'bad_request', message: 'file field required' } }, 400)
  }
  if (typeof langId !== 'string' || !UUID_RE.test(langId)) {
    return c.json({ error: { code: 'bad_request', message: 'asset_language_id must be a uuid' } }, 400)
  }
  if (!GITHUB_MIME_EXT[file.type]) {
    return c.json({ error: { code: 'bad_request', message: `Unsupported type: ${file.type} (JPEG/PNG/WebP only)` } }, 400)
  }
  if (file.size > GITHUB_MAX_FILE_SIZE) {
    return c.json({ error: { code: 'bad_request', message: 'File too large (max 15 MB)' } }, 413)
  }

  // 语言行校验（含 asset 归属）
  const langRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/asset_languages?id=eq.${langId}&select=id,asset_id,language_code,assets(status)`,
    { headers: svc(c.env) },
  )
  if (!langRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const langRows = (await langRes.json()) as Array<{ id: string; asset_id: string; language_code: string; assets: { status: string } | null }>
  const lang = langRows[0]
  if (!lang) return c.json({ error: { code: 'not_found', message: 'Language not found' } }, 404)

  // 同语言既有图张数 → 序号（任意状态都计入，避免覆盖/乱序）
  const seqRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?select=sort_order&asset_language_id=eq.${langId}&order=sort_order.desc&limit=1`,
    { headers: svc(c.env) },
  )
  if (!seqRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const seqRows = (await seqRes.json()) as Array<{ sort_order: number }>
  const seq = (seqRows[0]?.sort_order ?? 0) + 1

  // 路径冻结（Owner Q1 裁决）: assets/{asset-uuid}/{langCode}/{filename}
  const filename = `${String(seq).padStart(2, '0')}-${crypto.randomUUID().slice(0, 8)}.${GITHUB_MIME_EXT[file.type]}`
  const sourcePath = `assets/${lang.asset_id}/${lang.language_code}/${filename}`

  const ownerId = crypto.randomUUID()
  const resourceKey = `al:${langId}`
  const headers = svc(c.env)
  let insertedId: string | null = null

  try {
    // [1] 抢租约（跨 isolate 串行）；RPC 缺失（0014 未应用）→ 明确 503 而非裸 500
    let leased: boolean
    try {
      leased = await claimLease(c.env, headers, resourceKey, ownerId)
    } catch {
      return c.json({ error: { code: 'db_not_provisioned', message: 'Lease RPC unavailable — migrations 0009-0014 not applied to this database' } }, 503)
    }
    if (!leased) {
      return c.json({ error: { code: 'lease_busy', message: 'Another upload/delete is in progress for this language' } }, 409)
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const expectedSha = await computeGitBlobSha(bytes)

      // [2] DB 先行 pending 态（H3：DB 不落成功态；公开视图只出 ready）
      const insRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/images`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          asset_language_id: langId,
          filename: file.name || filename,
          provider: 'github',
          storage_path: null,
          source_path: sourcePath,
          source_sha: expectedSha,
          mime_type: file.type,
          file_size: file.size,
          sort_order: seq,
          status: 'uploading',
        }),
      })
      if (!insRes.ok) throw new Error(`image row insert failed: ${insRes.status}`)
      const inserted = (await insRes.json()) as Array<{ id: string }>
      insertedId = inserted[0]?.id ?? null

      // [3] GitHub PUT（重试矩阵见 github.ts；成功判定 = 2xx 且 sha 一致）
      await withNetworkRetry(() => ghPutFile(cfg, sourcePath, bytes, expectedSha))

      // [4] finalize → ready
      if (insertedId) {
        const upd = await fetch(`${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${insertedId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'ready' }),
        })
        if (!upd.ok) throw new Error(`finalize update failed: ${upd.status}`) // 崩溃窗口 → sweeper 收敛
      }
      return c.json({ ok: true, image_id: insertedId, source_path: sourcePath, status: 'ready' })
    } catch (e) {
      // 失败路径: 行 → failed（公开不可见，保留审计）；PUT 已落盘的矛盾态交 sweeper
      if (insertedId) {
        await fetch(`${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${insertedId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'failed' }),
        }).catch(() => {})
        await writeAudit(c.env, 'github.upload.failed', 'images', insertedId, auth.userId, {
          source_path: sourcePath,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      const mapped = mapGithubError(e)
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status)
    }
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// POST /api/admin/images/github-delete —— {imageId}
//   Owner 必改闭环: 远端删除成功前绝不物理删 DB 行（ready → deleting → DELETE → 删行）
// ---------------------------------------------------------------------------
app.post('/api/admin/images/github-delete', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)

  let body: { imageId?: unknown }
  try {
    body = await c.req.json<{ imageId?: unknown }>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const imageId = body.imageId
  if (typeof imageId !== 'string' || !UUID_RE.test(imageId)) {
    return c.json({ error: { code: 'bad_request', message: 'imageId must be a uuid' } }, 400)
  }

  const rowRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${imageId}&select=id,asset_language_id,provider,status,source_path,source_sha`,
    { headers: svc(c.env) },
  )
  if (!rowRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const rows = (await rowRes.json()) as ImageRowSvc[]
  const img = rows[0]
  if (!img || img.provider !== 'github' || !img.source_path) {
    return c.json({ error: { code: 'not_found', message: 'GitHub image not found' } }, 404)
  }
  if (img.status === 'uploading') {
    return c.json({ error: { code: 'upload_in_progress', message: 'Image is still uploading; retry later or wait for sweeper' } }, 409)
  }
  if (img.status !== 'ready' && img.status !== 'deleting') {
    return c.json({ error: { code: 'not_deletable', message: `Image status is ${img.status}; nothing to delete` } }, 409)
  }

  const ownerId = crypto.randomUUID()
  const resourceKey = `al:${img.asset_language_id}`
  const headers = svc(c.env)

  // 租约抢占；RPC 缺失（0014 未应用）→ 明确 503 而非裸 500
  let leased: boolean
  try {
    leased = await claimLease(c.env, headers, resourceKey, ownerId)
  } catch {
    return c.json({ error: { code: 'db_not_provisioned', message: 'Lease RPC unavailable — migrations 0009-0014 not applied to this database' } }, 503)
  }
  if (!leased) {
    return c.json({ error: { code: 'lease_busy', message: 'Another upload/delete is in progress for this language' } }, 409)
  }

  try {
    // ready → deleting（公开即刻不可见）
    if (img.status === 'ready') {
      const patch = await fetch(`${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${imageId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'deleting' }),
      })
      if (!patch.ok) return c.json({ error: { code: 'internal', message: 'Status update failed' } }, 500)
    }

    try {
      await withNetworkRetry(() => ghDeleteFile(cfg, img.source_path!))
      // 远端成功（或 404=目标态已达）→ 物理删 DB 行（触发 image.deleted 审计）
      const del = await fetch(`${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${imageId}`, {
        method: 'DELETE',
        headers,
      })
      if (!del.ok) {
        // 远端已删但行未删 → sweeper 下轮 404 路径收敛
        await writeAudit(c.env, 'github.delete.retry', 'images', imageId, auth.userId, { stage: 'db_delete_failed', status: del.status })
        return c.json({ error: { code: 'internal', message: 'Row deletion failed; sweeper will reconcile' } }, 502)
      }
      return c.json({ ok: true, deleted: true })
    } catch (e) {
      // 远端失败 → 保留 deleting 行，sweeper 重试（H3 删除半边闭环）
      await writeAudit(c.env, 'github.delete.retry', 'images', imageId, auth.userId, {
        source_path: img.source_path,
        error: e instanceof Error ? e.message : String(e),
      })
      const mapped = mapGithubError(e)
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status)
    }
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ===========================================================================
// ===========================================================================
// V1.5 B1 — 360° Sequence 管理（Gate docs/v1.5/02 §G1–G3，Owner 批准方案 B）
//   Git Data API：blob 幂等（内容寻址）+ 单 tree/commit（withTreeCommitRetry 冲突重试 ≤2）
//   H3：blob sha 本地预计算 = DB 登记 = GitHub 响应校验；complete 抽验首帧；
//       崩溃窗口交 360 sweeper（同 images 语义）
//   路径冻结: assets/{asset-id}/360/{sequence-id}/{frame-index 4位}.png（禁 slug）
//   审计: 360.sequence.created / activated / deleted / 360.upload.failed（allowlist 48）
// ===========================================================================

const FRAME_MIME_SET = new Set(Object.keys(GITHUB_MIME_EXT))
const FRAME_MAX_SIZE = 5 * 1024 * 1024
const FRAME_BATCH_MAX = 20 // Gate D3 + 生产实测：CF 单次调用子请求配额 50；合并登记后 20 帧/批 ≈ 25 子请求
const SEQ_LEASE_TTL = 180

interface SeqRowSvc {
  id: string
  asset_id: string
  frame_count: number
  status: string
  source_sha: string | null
}
interface FrameRowSvc {
  id: string
  frame_index: number
  source_path: string
  blob_sha: string | null
  status: string
}

function frameSourcePath(assetId: string, seqId: string, index: number): string {
  return `assets/${assetId}/360/${seqId}/${String(index).padStart(4, '0')}.png`
}

async function fetchSequence(env: Env, headers: Record<string, string>, seqId: string): Promise<SeqRowSvc | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_sequences?id=eq.${seqId}&select=id,asset_id,frame_count,status,source_sha`, { headers })
  if (!res.ok) throw new Error(`sequence fetch failed: ${res.status}`)
  const rows = (await res.json()) as SeqRowSvc[]
  return rows[0] ?? null
}

async function fetchFrames(env: Env, headers: Record<string, string>, seqId: string): Promise<FrameRowSvc[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_frames?sequence_id=eq.${seqId}&select=id,frame_index,source_path,blob_sha,status&order=frame_index.asc`, { headers })
  if (!res.ok) throw new Error(`frames fetch failed: ${res.status}`)
  return (await res.json()) as FrameRowSvc[]
}

async function patchSequence(env: Env, headers: Record<string, string>, seqId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_sequences?id=eq.${seqId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
  if (!res.ok) throw new Error(`sequence patch failed: ${res.status}`)
}

async function patchFrame(env: Env, headers: Record<string, string>, frameId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_frames?id=eq.${frameId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
  if (!res.ok) throw new Error(`frame patch failed: ${res.status}`)
}

/**
 * complete 核心（端点与 sweeper 共用）：
 * 校验帧齐全 → 单 tree/commit → 首帧 meta 抽验（H3）→ frames ready + sequence ready。
 * 已 ready → 幂等返回。任何失败 → sequence failed + 审计（调用方决定响应）。
 */
async function completeSequenceInternal(env: Env, headers: Record<string, string>, cfg: NonNullable<ReturnType<typeof ghConfig>>, seq: SeqRowSvc, actorId: string | null): Promise<{ already: boolean; commitSha: string | null }> {
  if (seq.status === 'ready') return { already: true, commitSha: seq.source_sha }
  const frames = await fetchFrames(env, headers, seq.id)
  const missing = frames.filter((f) => !f.blob_sha).map((f) => f.frame_index)
  if (frames.length !== seq.frame_count || missing.length > 0) {
    await patchSequence(env, headers, seq.id, { status: 'failed' })
    await writeAudit(env, '360.upload.failed', 'asset_360_sequences', seq.id, actorId, { stage: 'complete_missing_frames', expected: seq.frame_count, actual: frames.length, missing })
    const err = new Error(`missing frames: ${missing.length ? missing.join(',') : 'count mismatch'}`)
    Object.assign(err, { seqComplete: true })
    throw err
  }
  const entries: TreeEntry[] = frames.map((f) => ({ path: f.source_path, sha: f.blob_sha as string }))
  const { commitSha } = await withTreeCommitRetry(cfg, entries, `360 sequence ${seq.id} (${frames.length} frames) (acmerd-image-manager)`)
  // H3 抽验：首帧远端 sha 必须与登记一致（tree 用登记 sha 构建，正常恒等；防登记被污染）
  const spot = await ghGetMeta(cfg, frames[0].source_path).catch(() => null)
  if (!spot || spot.sha !== frames[0].blob_sha) {
    await patchSequence(env, headers, seq.id, { status: 'failed' })
    await writeAudit(env, '360.upload.failed', 'asset_360_sequences', seq.id, actorId, { stage: 'complete_spot_check', source_path: frames[0].source_path, remote_sha: spot?.sha ?? null })
    throw new Error('spot check failed: remote sha mismatch')
  }
  await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_frames?sequence_id=eq.${seq.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'ready' }) })
  await patchSequence(env, headers, seq.id, { status: 'ready', source_sha: commitSha })
  await writeAudit(env, '360.sequence.created', 'asset_360_sequences', seq.id, actorId, { stage: 'complete', commit_sha: commitSha, frames: frames.length })
  return { already: false, commitSha }
}

/** 序列删除核心（端点与 sweeper 共用）：GitHub 目录单 commit 删除 → 行物理删除 */
async function deleteSequenceInternal(env: Env, headers: Record<string, string>, cfg: NonNullable<ReturnType<typeof ghConfig>>, seq: SeqRowSvc, actorId: string | null): Promise<{ removed: number }> {
  const dir = `assets/${seq.asset_id}/360/${seq.id}`
  await patchSequence(env, headers, seq.id, { status: 'deleting' })
  const { removed } = await ghRemoveDir(cfg, dir, `delete 360 sequence ${seq.id} (acmerd-image-manager)`)
  await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_frames?sequence_id=eq.${seq.id}`, { method: 'DELETE', headers })
  await fetch(`${env.SUPABASE_URL}/rest/v1/asset_360_sequences?id=eq.${seq.id}`, { method: 'DELETE', headers })
  await writeAudit(env, '360.sequence.deleted', 'asset_360_sequences', seq.id, actorId, { asset_id: seq.asset_id, remote_removed: removed })
  return { removed }
}

// ---- [1] 创建序列（draft + 预生成全部帧行） ----
app.post('/api/admin/assets/:assetId/360-sequences', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)
  const { assetId } = c.req.param()

  let body: { frame_count?: unknown }
  try { body = await c.req.json() } catch { return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400) }
  const frameCount = Number(body.frame_count)
  if (![36, 72, 144, 360].includes(frameCount)) {
    return c.json({ error: { code: 'bad_request', message: 'frame_count must be one of 36/72/144/360' } }, 400)
  }
  const headers = svc(c.env)
  const aRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}&select=id`, { headers })
  if (!aRes.ok) return c.json({ error: { code: 'internal', message: 'Asset lookup failed' } }, 500)
  if (((await aRes.json()) as Array<unknown>).length === 0) {
    return c.json({ error: { code: 'not_found', message: 'Asset not found' } }, 404)
  }

  const ownerId = auth.userId
  const resourceKey = `asset360:new:${assetId}`
  const leased = await claimLease(c.env, headers, resourceKey, ownerId, 60).catch(() => false)
  if (!leased) return c.json({ error: { code: 'lease_busy', message: 'Another 360 operation is in progress for this asset' } }, 409)

  try {
    const insRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/asset_360_sequences`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ asset_id: assetId, frame_count: frameCount, status: 'draft' }),
    })
    if (!insRes.ok) throw new Error(`sequence insert failed: ${insRes.status}`)
    const seq = ((await insRes.json()) as SeqRowSvc[])[0]

    const frames = Array.from({ length: frameCount }, (_, i) => ({
      sequence_id: seq.id,
      frame_index: i + 1,
      provider: 'github',
      source_path: frameSourcePath(assetId, seq.id, i + 1),
      status: 'pending',
    }))
    const frRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/asset_360_frames`, {
      method: 'POST',
      headers,
      body: JSON.stringify(frames),
    })
    if (!frRes.ok) {
      // 帧行失败 → 序列回收（Cascade 由 DB；此处显式删）
      await fetch(`${c.env.SUPABASE_URL}/rest/v1/asset_360_sequences?id=eq.${seq.id}`, { method: 'DELETE', headers })
      throw new Error(`frame rows insert failed: ${frRes.status}`)
    }
    await writeAudit(c.env, '360.sequence.created', 'asset_360_sequences', seq.id, auth.userId, { asset_id: assetId, frame_count: frameCount, stage: 'draft' })
    return c.json({ ok: true, sequence_id: seq.id, frame_count: frameCount, frames: frames.map((f) => ({ frame_index: f.frame_index, source_path: f.source_path })) })
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ---- [2] 序列清单（admin 全状态） ----
app.get('/api/admin/assets/:assetId/360-sequences', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const headers = svc(c.env)
  const { assetId } = c.req.param()
  const seqRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/asset_360_sequences?asset_id=eq.${assetId}&select=id,frame_count,status,source_sha,created_at,updated_at&order=created_at.desc`, { headers })
  if (!seqRes.ok) return c.json({ error: { code: 'internal', message: 'Fetch failed' } }, 500)
  const seqs = (await seqRes.json()) as Array<SeqRowSvc & { created_at: string; updated_at: string }>
  const activeRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}&select=active_360_sequence_id`, { headers })
  const activeId = activeRes.ok ? ((await activeRes.json()) as Array<{ active_360_sequence_id: string | null }>)[0]?.active_360_sequence_id ?? null : null
  const out = [] as Array<{ id: string; frame_count: number; status: string; is_active: boolean; uploaded_frames: number }>
  for (const s of seqs) {
    const cnt = await fetch(`${c.env.SUPABASE_URL}/rest/v1/asset_360_frames?sequence_id=eq.${s.id}&blob_sha=neq.null&select=frame_index`, { headers })
    const uploaded = cnt.ok ? ((await cnt.json()) as Array<{ frame_index: number }>).length : 0
    out.push({ id: s.id, frame_count: s.frame_count, status: s.status, is_active: s.id === activeId, uploaded_frames: uploaded })
  }
  return c.json({ ok: true, sequences: out, active_sequence_id: activeId })
})

// ---- [3] 分批传帧（multipart：part 名 = 帧序号，如 "3"） ----
app.post('/api/admin/360-sequences/:seqId/frames', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)
  const { seqId } = c.req.param()
  const headers = svc(c.env)

  const seq = await fetchSequence(c.env, headers, seqId)
  if (!seq) return c.json({ error: { code: 'not_found', message: 'Sequence not found' } }, 404)
  if (seq.status === 'ready' || seq.status === 'deleting') {
    return c.json({ error: { code: 'invalid_state', message: `Sequence is ${seq.status}; frames cannot be uploaded` } }, 409)
  }

  let form: FormData
  try { form = await c.req.formData() } catch {
    return c.json({ error: { code: 'bad_request', message: 'multipart/form-data body required' } }, 400)
  }
  const parts: Array<{ index: number; file: File }> = []
  for (const [name, value] of form.entries()) {
    const m = name.match(/^f_(\d+)$/)
    if (m && value instanceof File) parts.push({ index: Number(m[1]), file: value })
  }
  if (parts.length === 0) return c.json({ error: { code: 'bad_request', message: 'No frame parts found (expected part names f_{index})' } }, 400)
  if (parts.length > FRAME_BATCH_MAX) {
    return c.json({ error: { code: 'bad_request', message: `Batch too large: max ${FRAME_BATCH_MAX} frames per request` } }, 400)
  }

  const ownerId = auth.userId
  const resourceKey = `asset360:${seqId}`
  const leased = await claimLease(c.env, headers, resourceKey, ownerId, SEQ_LEASE_TTL).catch(() => false)
  if (!leased) return c.json({ error: { code: 'lease_busy', message: 'Another 360 operation is in progress for this sequence' } }, 409)

  const uploaded: Array<{ frame_index: number; blob_sha: string }> = []
  const failed: Array<{ frame_index: number; error: string }> = []
  try {
    if (seq.status === 'draft') await patchSequence(c.env, headers, seqId, { status: 'uploading' })
    const frames = await fetchFrames(c.env, headers, seqId)
    const byIndex = new Map(frames.map((f) => [f.frame_index, f]))

    // 批内并发池（4 路）：单帧 GitHub 往返 ~1–3s，串行会让 360 帧耗时 ~20 分钟；
    // 并发 4 仍远低于 GitHub 次级限流阈值，且每帧各自带 withNetworkRetry 预算。
    const BLOB_CONCURRENCY = 4
    let cursor = 0
    // 整批登记合并为 1 次 RPC（0023）：逐帧 PATCH 会让一批 24 帧吃掉 48+ 子请求，
    // 在生产撞满 Cloudflare 单次调用配额（本地 workerd 不演算，故 B1 沙箱未暴露）。
    const registrations: Array<{ id: string; blob_sha: string; file_size: number }> = []
    const workerLoop = async () => {
      while (cursor < parts.length) {
        const { index, file } = parts[cursor++]
        try {
          if (!Number.isInteger(index) || index < 1 || index > seq.frame_count) throw new Error(`frame_index out of range: ${index}`)
          if (!FRAME_MIME_SET.has(file.type)) throw new Error(`Unsupported type: ${file.type}`)
          if (file.size > FRAME_MAX_SIZE) throw new Error(`File too large: ${file.size} > ${FRAME_MAX_SIZE}`)
          const frame = byIndex.get(index)
          if (!frame) throw new Error(`frame row missing for index ${index}`)
          const bytes = new Uint8Array(await file.arrayBuffer())
          const sha = await computeGitBlobSha(bytes)
          await ghPutBlob(cfg, bytes, sha)
          registrations.push({ id: frame.id, blob_sha: sha, file_size: file.size })
          uploaded.push({ frame_index: index, blob_sha: sha })
        } catch (e) {
          failed.push({ frame_index: index, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, parts.length) }, workerLoop))

    if (registrations.length > 0) {
      const rpc = await fetch(`${c.env.SUPABASE_URL}/rest/v1/rpc/update_asset_360_frames`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_frames: registrations }),
      })
      if (!rpc.ok) {
        // 整批登记失败：远端 blob 属 Gate D5 已接受的可清理孤儿；客户端重发该批即可（内容寻址幂等）
        return c.json({ error: { code: 'retry_later', message: `frame registration failed (HTTP ${rpc.status}); re-send this batch` } }, 502)
      }
    }
    return c.json({ ok: failed.length === 0, uploaded, failed })
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ---- [4] complete（校验齐全 → 单 commit → ready；幂等） ----
app.post('/api/admin/360-sequences/:seqId/complete', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)
  const { seqId } = c.req.param()
  const headers = svc(c.env)

  const seq = await fetchSequence(c.env, headers, seqId)
  if (!seq) return c.json({ error: { code: 'not_found', message: 'Sequence not found' } }, 404)

  const ownerId = auth.userId
  const resourceKey = `asset360:${seqId}`
  const leased = await claimLease(c.env, headers, resourceKey, ownerId, SEQ_LEASE_TTL).catch(() => false)
  if (!leased) return c.json({ error: { code: 'lease_busy', message: 'Another 360 operation is in progress for this sequence' } }, 409)
  try {
    const frames = await fetchFrames(c.env, headers, seqId)
    if (seq.status !== 'ready') {
      const missing = frames.filter((f) => !f.blob_sha).map((f) => f.frame_index)
      if (frames.length !== seq.frame_count || missing.length > 0) {
        return c.json({ error: { code: 'frames_incomplete', message: 'Sequence frames incomplete', expected: seq.frame_count, uploaded: frames.length, missing } }, 409)
      }
    }
    const r = await completeSequenceInternal(c.env, headers, cfg, seq, auth.userId)
    return c.json({ ok: true, already: r.already, commit_sha: r.commitSha })
  } catch (e) {
    const mapped = mapGithubError(e)
    return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status)
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ---- [5] 激活（原子 UPDATE；守卫触发器兜底 same-asset + ready） ----
app.post('/api/admin/360-sequences/:seqId/activate', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const { seqId } = c.req.param()
  const headers = svc(c.env)
  const seq = await fetchSequence(c.env, headers, seqId)
  if (!seq) return c.json({ error: { code: 'not_found', message: 'Sequence not found' } }, 404)
  if (seq.status !== 'ready') {
    return c.json({ error: { code: 'invalid_state', message: `Sequence is ${seq.status}; only ready sequences can be activated` } }, 409)
  }
  const upd = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${seq.asset_id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ active_360_sequence_id: seqId }),
  })
  if (!upd.ok) {
    const detail = await upd.text()
    const invalid = detail.includes('360_ACTIVE_INVALID')
    return c.json({ error: { code: invalid ? 'invalid_state' : 'internal', message: invalid ? 'Sequence is not activatable (guard)' : 'Activation failed' } }, invalid ? 409 : 500)
  }
  await writeAudit(c.env, '360.sequence.activated', 'assets', seq.asset_id, auth.userId, { sequence_id: seqId })
  return c.json({ ok: true, asset_id: seq.asset_id, sequence_id: seqId })
})

// ---- [6] 删除非 active 序列（单 commit 删目录；失败留 deleting 交 sweeper） ----
app.delete('/api/admin/360-sequences/:seqId', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)
  const { seqId } = c.req.param()
  const headers = svc(c.env)
  const seq = await fetchSequence(c.env, headers, seqId)
  if (!seq) return c.json({ error: { code: 'not_found', message: 'Sequence not found' } }, 404)

  const aRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${seq.asset_id}&select=active_360_sequence_id`, { headers })
  const activeId = aRes.ok ? ((await aRes.json()) as Array<{ active_360_sequence_id: string | null }>)[0]?.active_360_sequence_id ?? null : null
  if (activeId === seqId) {
    return c.json({ error: { code: 'sequence_is_active', message: 'Deactivate (remove active 360) before deleting this sequence' } }, 409)
  }

  const ownerId = auth.userId
  const resourceKey = `asset360:${seqId}`
  const leased = await claimLease(c.env, headers, resourceKey, ownerId, SEQ_LEASE_TTL).catch(() => false)
  if (!leased) return c.json({ error: { code: 'lease_busy', message: 'Another 360 operation is in progress for this sequence' } }, 409)
  try {
    const r = await deleteSequenceInternal(c.env, headers, cfg, seq, auth.userId)
    return c.json({ ok: true, removed_remote_files: r.removed })
  } catch (e) {
    // GitHub 失败 → 行保留 deleting，sweeper 重试（同 images 语义）
    const mapped = mapGithubError(e)
    return c.json({ error: { code: 'retry_later', message: 'Remote deletion failed; sequence kept in deleting state for sweeper', detail: mapped.code } }, 502)
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// ---- [7] 移除 active 360（先下线指针 → 删目录 → 删行；规格 §47） ----
app.delete('/api/admin/assets/:assetId/360', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)
  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)
  const { assetId } = c.req.param()
  const headers = svc(c.env)

  const aRes = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}&select=active_360_sequence_id`, { headers })
  if (!aRes.ok) return c.json({ error: { code: 'internal', message: 'Asset lookup failed' } }, 500)
  const activeId = ((await aRes.json()) as Array<{ active_360_sequence_id: string | null }>)[0]?.active_360_sequence_id ?? null
  if (!activeId) return c.json({ ok: true, removed: false, message: 'No active 360 sequence' })

  const seq = await fetchSequence(c.env, headers, activeId)
  if (!seq) {
    // 悬垂指针（序列行已删但 FK 未清？理论不可能：on delete set null）→ 直接清指针
    await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}`, { method: 'PATCH', headers, body: JSON.stringify({ active_360_sequence_id: null }) })
    return c.json({ ok: true, removed: true })
  }

  const ownerId = auth.userId
  const resourceKey = `asset360:${activeId}`
  const leased = await claimLease(c.env, headers, resourceKey, ownerId, SEQ_LEASE_TTL).catch(() => false)
  if (!leased) return c.json({ error: { code: 'lease_busy', message: 'Another 360 operation is in progress for this sequence' } }, 409)
  try {
    // [1] 先下线指针（前台即时消失；单语句原子）
    await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}`, { method: 'PATCH', headers, body: JSON.stringify({ active_360_sequence_id: null }) })
    // [2] GitHub 删目录 + 删行（失败 → deleting，sweeper 重试；前台已安全退出）
    const r = await deleteSequenceInternal(c.env, headers, cfg, seq, auth.userId)
    return c.json({ ok: true, removed: true, removed_remote_files: r.removed })
  } catch (e) {
    const mapped = mapGithubError(e)
    return c.json({ error: { code: 'retry_later', message: '360 module deactivated; remote cleanup scheduled for sweeper', detail: mapped.code } }, 502)
  } finally {
    await releaseLease(c.env, headers, resourceKey, ownerId).catch(() => {})
  }
})

// Scheduled sweeper（Gate §3 对账清扫；cron 每 10 分钟，单轮 ≤10 行）
//   uploading: GET sha === source_sha → ready / 404 → failed
//   failed:    sha 一致 → ready；sha 不一致 → 补偿删除远端（orphan.purged）
//   deleting:  远端 DELETE 成功/404 → 物理删 DB 行
// ===========================================================================
async function reconcileSweeper(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const cfg = ghConfig(env)
  if (!cfg) return
  const headers = svc(env)

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/images?select=id,asset_language_id,provider,status,source_path,source_sha&status=in.(uploading,failed,deleting)&limit=10`,
    { headers },
  )
  if (!res.ok) return
  const rows = (await res.json()) as ImageRowSvc[]

  ctx.waitUntil(
    (async () => {
      for (const img of rows) {
        if (img.provider !== 'github' || !img.source_path) continue
        const resourceKey = `al:${img.asset_language_id}`
        const ownerId = crypto.randomUUID()
        let leased = false
        try {
          leased = await claimLease(env, headers, resourceKey, ownerId, 60)
          if (!leased) continue
          const meta = await ghGetMeta(cfg, img.source_path).catch(() => undefined)
          const patch = (status: string) =>
            fetch(`${env.SUPABASE_URL}/rest/v1/images?id=eq.${img.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status }) })

          if (img.status === 'uploading' || img.status === 'failed') {
            if (meta && img.source_sha && meta.sha === img.source_sha) {
              await patch('ready')
              await writeAudit(env, 'github.upload.recovered', 'images', img.id, null, { source_path: img.source_path, from: img.status })
            } else if (img.status === 'uploading' && !meta) {
              await patch('failed')
              await writeAudit(env, 'github.upload.failed', 'images', img.id, null, { source_path: img.source_path, stage: 'sweeper_not_found' })
            } else if (img.status === 'failed' && meta) {
              // sha 不一致（或未知 sha）→ 补偿删除矛盾对象
              await ghDeleteFile(cfg, img.source_path)
              await writeAudit(env, 'github.orphan.purged', 'images', img.id, null, { source_path: img.source_path })
            }
          } else if (img.status === 'deleting') {
            if (!meta) {
              // 远端已不存在 → 目标态已达 → 物理删行
              await fetch(`${env.SUPABASE_URL}/rest/v1/images?id=eq.${img.id}`, { method: 'DELETE', headers })
              await writeAudit(env, 'github.delete.retry', 'images', img.id, null, { source_path: img.source_path, result: 'remote_absent_row_deleted' })
            } else {
              try {
                await ghDeleteFile(cfg, img.source_path)
                await fetch(`${env.SUPABASE_URL}/rest/v1/images?id=eq.${img.id}`, { method: 'DELETE', headers })
                await writeAudit(env, 'github.delete.retry', 'images', img.id, null, { source_path: img.source_path, result: 'deleted' })
              } catch {
                await writeAudit(env, 'github.delete.retry', 'images', img.id, null, { source_path: img.source_path, result: 'remote_delete_failed' })
              }
            }
          }
        } catch (e) {
          console.error('sweeper row failed:', img.id, e)
        } finally {
          if (leased) await releaseLease(env, headers, resourceKey, ownerId).catch(() => {})
        }
      }
    })(),
  )
}

// 360 sweeper（Gate §G3：崩溃窗口收敛，语义同 images sweeper）
//   uploading/failed: 帧全齐（blob_sha 齐备）→ 重试单 commit complete；
//                     缺帧 → failed + 审计（不重复上传，等待管理端补传）
//   deleting:         ghRemoveDir 重试（404 即成功）→ 物理删行
// 单轮 ≤5 序列；lease 冲突（管理端正在操作）→ 本轮跳过
async function reconcile360Sweeper(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const cfg = ghConfig(env)
  if (!cfg) return
  const headers = svc(env)

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/asset_360_sequences?select=id,asset_id,frame_count,status,source_sha&status=in.(uploading,failed,deleting)&limit=5`,
    { headers },
  )
  if (!res.ok) return
  const rows = (await res.json()) as SeqRowSvc[]

  ctx.waitUntil(
    (async () => {
      for (const seq of rows) {
        const resourceKey = `asset360:${seq.id}`
        const ownerId = crypto.randomUUID()
        let leased = false
        try {
          leased = await claimLease(env, headers, resourceKey, ownerId, 60)
          if (!leased) continue
          // 行级重读（管理端可能已改变状态）
          const cur = await fetchSequence(env, headers, seq.id)
          if (!cur || cur.status === 'ready') continue

          if (cur.status === 'deleting') {
            await deleteSequenceInternal(env, headers, cfg, cur, null)
            continue
          }

          // uploading / failed：先收敛帧登记状态
          const frames = await fetchFrames(env, headers, cur.id)
          const missing = frames.filter((f) => !f.blob_sha).map((f) => f.frame_index)
          if (frames.length !== cur.frame_count || missing.length > 0) {
            if (cur.status !== 'failed') {
              await patchSequence(env, headers, cur.id, { status: 'failed' })
              await writeAudit(env, '360.upload.failed', 'asset_360_sequences', cur.id, null, { stage: 'sweeper_incomplete', expected: cur.frame_count, actual: frames.length, missing })
            }
            continue
          }
          // 帧全齐 → 重试 complete（内部含 ref 冲突重试 + 抽验；幂等）
          await completeSequenceInternal(env, headers, cfg, cur, null)
        } catch (e) {
          // seqComplete（缺帧/数量不符）→ 已标记 failed，属收敛结果而非故障
          if (e && typeof e === 'object' && (e as { seqComplete?: boolean }).seqComplete) continue
          // 其他（网络/ref 冲突重试耗尽等）→ 留待下轮；deleting 状态 GH 失败也走这里
          console.error('360 sweeper row failed:', seq.id, e)
        } finally {
          if (leased) await releaseLease(env, headers, resourceKey, ownerId).catch(() => {})
        }
      }
    })(),
  )
}

// ===========================================================================
// Phase 7 Admin Console —— 4 个新端点
//   * 全部 requireAdmin（authenticate 内已含 D2 硬门禁：
//     disabled=true → 403 {code:'account_disabled'}）
//   * 用户变更唯一写入通道 = service_role 调 admin_user_mutation RPC
//     （原子 + 锁内重读 + last-admin 普查 + 审计均在 DB 函数内完成）
// ===========================================================================
interface AdminRpcErrorBody {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
}

/** 把 admin_user_mutation RPC 非 2xx 响应映射为对外错误（识别 DB raise 短名前缀） */
function mapAdminMutationError(
  status: number,
  body: AdminRpcErrorBody,
): { status: 403 | 404 | 409 | 502; error: { code: string; message: string } } {
  const msg = typeof body?.message === 'string' ? body.message : ''
  if (
    msg.startsWith('SELF_DEMOTE_FORBIDDEN') ||
    msg.startsWith('SELF_DISABLE_FORBIDDEN') ||
    msg.startsWith('FORBIDDEN')
  ) {
    return { status: 403, error: { code: 'forbidden', message: 'Not allowed to perform this user change' } }
  }
  if (msg.startsWith('LAST_ADMIN')) {
    return { status: 409, error: { code: 'last_admin', message: 'Operation would leave no active admin' } }
  }
  if (msg.startsWith('TARGET_NOT_FOUND')) {
    return { status: 404, error: { code: 'not_found', message: 'Target user not found' } }
  }
  // 其余一律视为上游故障（参数错/实例异常等），不向前端泄露细节
  return { status: 502, error: { code: 'upstream_error', message: 'Admin service error' } }
}

interface MutationResult {
  user_id: string
  role: string
  disabled: boolean
  role_changed: boolean
  disabled_changed: boolean
}

/** 调 admin_user_mutation 的统一封装（null 字段 = 不变） */
async function callUserMutation(
  env: Env,
  p_actor: string,
  p_target: string,
  p_role: string | null,
  p_disabled: boolean | null,
): Promise<{ ok: true; result: MutationResult } | { ok: false; status: 403 | 404 | 409 | 502; error: { code: string; message: string } }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_user_mutation`, {
    method: 'POST',
    headers: svc(env),
    body: JSON.stringify({ p_actor, p_target, p_role, p_disabled }),
  })
  if (!res.ok) {
    let body: AdminRpcErrorBody = {}
    try {
      body = (await res.json()) as AdminRpcErrorBody
    } catch {
      body = {}
    }
    const mapped = mapAdminMutationError(res.status, body)
    return { ok: false, status: mapped.status, error: mapped.error }
  }
  const result = (await res.json()) as MutationResult
  return { ok: true, result }
}

// ===========================================================================
// GET /api/admin/users —— 用户列表（D1：Auth Admin API 列举 + service-role join）
//   分页：?page=&per_page=（默认 1/20，per_page ≤100）；
//   GoTrue 返回 envelope {users,aud} + x-total-count/Link（D3 实测）。
//   本端点返回自包含 envelope {users,total,page,per_page}，避免前端依赖响应头。
// ===========================================================================
interface GoTrueUserEnvelope {
  users?: Array<{
    id: string
    email?: string | null
    created_at?: string | null
    last_sign_in_at?: string | null
  }>
  aud?: string | null
}

app.get('/api/admin/users', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const rawPage = c.req.query('page')
  const rawPer = c.req.query('per_page')
  const page = rawPage === undefined ? 1 : /^\d+$/.test(rawPage) ? Number(rawPage) : NaN
  const perPage = rawPer === undefined ? 20 : /^\d+$/.test(rawPer) ? Number(rawPer) : NaN
  if (!Number.isInteger(page) || page < 1) {
    return c.json({ error: { code: 'bad_request', message: 'page must be a positive integer' } }, 400)
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    return c.json({ error: { code: 'bad_request', message: 'per_page must be an integer 1-100' } }, 400)
  }

  // 1) Auth Admin API 列举（D3 实测可用；service role）
  const listRes = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
    headers: svc(c.env),
  })
  if (!listRes.ok) {
    console.error('Admin users list failed:', listRes.status)
    return c.json({ error: { code: 'upstream_error', message: 'User list unavailable' } }, 502)
  }
  const totalRaw = listRes.headers.get('x-total-count')
  const total = totalRaw !== null && /^\d+$/.test(totalRaw) ? Number(totalRaw) : 0
  const envelope = (await listRes.json()) as GoTrueUserEnvelope
  const goTrueUsers = Array.isArray(envelope.users) ? envelope.users : []
  if (goTrueUsers.length === 0) {
    return c.json({ users: [], total, page, per_page: perPage })
  }

  // 2) service-role join：user_roles(role) + profiles(display_name/disabled)
  const inList = goTrueUsers.map((u) => `"${u.id}"`).join(',')
  const [roleRes, profRes] = await Promise.all([
    fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles?user_id=in.(${inList})&select=user_id,role`, {
      headers: svc(c.env),
    }),
    fetch(`${c.env.SUPABASE_URL}/rest/v1/profiles?id=in.(${inList})&select=id,display_name,disabled`, {
      headers: svc(c.env),
    }),
  ])
  if (!roleRes.ok || !profRes.ok) {
    console.error('Admin users join failed:', roleRes.status, profRes.status)
    return c.json({ error: { code: 'upstream_error', message: 'User list unavailable' } }, 502)
  }
  const rolesById = new Map<string, string>()
  for (const r of (await roleRes.json()) as Array<{ user_id: string; role: string }>) {
    if (!rolesById.has(r.user_id)) rolesById.set(r.user_id, r.role)
  }
  const profById = new Map<string, { display_name: string | null; disabled: boolean }>()
  for (const p of (await profRes.json()) as Array<{ id: string; display_name: string | null; disabled: boolean }>) {
    profById.set(p.id, { display_name: p.display_name, disabled: p.disabled === true })
  }

  const users = goTrueUsers.map((u) => {
    const prof = profById.get(u.id)
    return {
      id: u.id,
      email: typeof u.email === 'string' ? u.email : null,
      display_name: prof ? prof.display_name : null,
      // 缺省 'user'：既有注册流程保证每个账号都有 user_roles 行；防御性兜底不伪造更高权限
      role: rolesById.get(u.id) ?? 'user',
      disabled: prof ? prof.disabled : false,
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
    }
  })
  return c.json({ users, total, page, per_page: perPage })
})

// ===========================================================================
// POST /api/admin/users/:userId/role —— 改角色（D6 原子路径）
//   仅接受 'user' | 'admin'；self-demote 由 DB 拒绝（SELF_DEMOTE_FORBIDDEN → 403）
// ===========================================================================
interface RoleBody {
  role?: unknown
}

app.post('/api/admin/users/:userId/role', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const targetId = c.req.param('userId')
  if (!UUID_RE.test(targetId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid user id' } }, 400)
  }

  let body: RoleBody
  try {
    body = await c.req.json<RoleBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const role = body.role
  if (role !== 'user' && role !== 'admin') {
    return c.json({ error: { code: 'bad_request', message: 'role must be "user" or "admin"' } }, 400)
  }

  const mut = await callUserMutation(c.env, auth.userId, targetId, role, null)
  if (!mut.ok) return c.json({ error: mut.error }, mut.status)
  return c.json(mut.result)
})

// ===========================================================================
// POST /api/admin/users/:userId/disabled —— 禁用/启用（D2/D6/D3 组合）
//   先原子落库（admin_user_mutation），成功后再 best-effort 撤会话：
//   撤会话失败仅 console.error，绝不回滚、绝不阻塞（D3 裁决）。
// ===========================================================================
interface DisabledBody {
  disabled?: unknown
}

app.post('/api/admin/users/:userId/disabled', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const targetId = c.req.param('userId')
  if (!UUID_RE.test(targetId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid user id' } }, 400)
  }

  let body: DisabledBody
  try {
    body = await c.req.json<DisabledBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  if (typeof body.disabled !== 'boolean') {
    return c.json({ error: { code: 'bad_request', message: 'disabled must be a boolean' } }, 400)
  }
  const disabled = body.disabled

  // 1) 先落库（原子 + 审计在 DB 函数内完成）
  const mut = await callUserMutation(c.env, auth.userId, targetId, null, disabled)
  if (!mut.ok) return c.json({ error: mut.error }, mut.status)

  // 2) 禁用成功后再 best-effort 撤会话（D3 实测：/admin/users/{id}/logout 已注册；
  //    /sessions* 端点在本实例返回 404 不可用）
  if (disabled) {
    try {
      const rev = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users/${targetId}/logout`, {
        method: 'POST',
        headers: svc(c.env),
      })
      if (!rev.ok) console.error('Session revoke best-effort failed:', rev.status)
    } catch (e) {
      console.error('Session revoke best-effort threw:', e)
    }
  }

  return c.json(mut.result)
})

// ===========================================================================
// POST /api/admin/users/:userId/credits —— Set Balance / Toggle Unlimited（总纲 §40/§42）
//   balance 直接设定值（非增量，Owner 裁决语义）→ adjust_credits RPC（admin_adjustment 审计流水）
//   unlimited 独立字段（unlimited=true 旁路扣分；关闭后恢复原余额）
//   两个操作都允许只传其一；balance 语义 = 设定后余额（≥0）
// ===========================================================================
interface CreditsBody {
  balance?: unknown
  unlimited?: unknown
  reason?: unknown
  operation?: unknown
}

app.post('/api/admin/users/:userId/credits', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const targetId = c.req.param('userId')
  if (!UUID_RE.test(targetId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid user id' } }, 400)
  }

  let body: CreditsBody
  try {
    body = await c.req.json<CreditsBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const hasBalance = body.balance !== undefined
  const hasUnlimited = body.unlimited !== undefined
  if (!hasBalance && !hasUnlimited) {
    return c.json({ error: { code: 'bad_request', message: 'balance or unlimited required' } }, 400)
  }
  let balance: number | null = null
  if (hasBalance) {
    if (typeof body.balance !== 'number' || !Number.isFinite(body.balance) || body.balance < 0 || body.balance > 1e9) {
      return c.json({ error: { code: 'bad_request', message: 'balance must be a number >= 0' } }, 400)
    }
    balance = body.balance
  }
  let unlimited: boolean | null = null
  if (hasUnlimited) {
    if (typeof body.unlimited !== 'boolean') {
      return c.json({ error: { code: 'bad_request', message: 'unlimited must be boolean' } }, 400)
    }
    unlimited = body.unlimited
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null

  // 1) unlimited 更新（普通 service_role PATCH；不碰 balance，无流水语义）
  if (unlimited !== null) {
    const res = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/credit_accounts?user_id=eq.${targetId}`,
      {
        method: 'PATCH',
        headers: { ...svc(c.env), Prefer: 'return=representation' },
        body: JSON.stringify({ unlimited }),
      },
    )
    if (!res.ok) {
      console.error('Unlimited update failed:', res.status)
      return c.json({ error: { code: 'upstream_error', message: 'Unlimited update failed' } }, 502)
    }
    // V1.3.1 BUG-A 修复：命中 0 行（用户无 credit_accounts）时 PostgREST 返回 200+空数组，
    // 旧逻辑会记审计"成功"但 DB 实际未变 → 静默 no-op。这里显式判 404。
    const rows = (await res.json()) as Array<Record<string, unknown>>
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ error: { code: 'credit_account_missing', message: 'Credit account missing' } }, 404)
    }
    await writeAudit(c.env, 'credits.unlimited_changed', 'profiles', targetId, auth.userId, {
      unlimited,
    })
  }

  // 2) balance 设定（adjust_credits RPC：原子 + admin_adjustment 流水 from/to/reason）
  let newBalance: number | null = null
  if (balance !== null) {
    const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/rpc/adjust_credits`, {
      method: 'POST',
      headers: svc(c.env),
      body: JSON.stringify({
        p_user_id: targetId,
        p_balance: balance,
        p_reason: reason,
        p_actor_id: auth.userId,
        p_operation: typeof body.operation === 'string' && body.operation ? body.operation : 'set_balance',
      }),
    })
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { message?: string } | null
      const msg = errBody?.message ?? ''
      if (/CREDIT_ACCOUNT_MISSING/.test(msg)) {
        return c.json({ error: { code: 'credit_account_missing', message: 'Credit account missing' } }, 404)
      }
      console.error('adjust_credits failed:', res.status, msg)
      return c.json({ error: { code: 'upstream_error', message: 'Balance update failed' } }, 502)
    }
    newBalance = Number((await res.json()) as unknown)
  }

  return c.json({ ok: true, balance: newBalance, unlimited })
})

// ===========================================================================
// V1.3.1 G4: 批量调整积分（整批原子）
//   POST /api/admin/users/credits/batch { user_ids: uuid[], delta: number, reason: string }
//   → admin_batch_adjust_credits RPC（0017；SECURITY DEFINER 内两段循环：
//     先全锁校验再逐个 update+流水，任一失败 raise → 单事务整体回滚）。
//   ledger 每用户一条 admin_adjustment（metadata.operation='batch'）；
//   审计一行 credits.adjusted（allowlist 零新增）。
// ===========================================================================

interface BatchCreditsBody {
  user_ids?: unknown
  delta?: unknown
  reason?: unknown
}

app.post('/api/admin/users/credits/batch', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: BatchCreditsBody
  try {
    body = await c.req.json<BatchCreditsBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  if (!Array.isArray(body.user_ids) || body.user_ids.length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'user_ids must be a non-empty array' } }, 400)
  }
  if (body.user_ids.length > 100) {
    return c.json({ error: { code: 'bad_request', message: 'batch limit is 100 users' } }, 400)
  }
  const ids = body.user_ids.map(String)
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      return c.json({ error: { code: 'bad_request', message: 'invalid user id in user_ids' } }, 400)
    }
  }
  if (new Set(ids).size !== ids.length) {
    return c.json({ error: { code: 'bad_request', message: 'duplicate user ids' } }, 400)
  }
  if (typeof body.delta !== 'number' || !Number.isFinite(body.delta) || body.delta === 0) {
    return c.json({ error: { code: 'bad_request', message: 'delta must be a non-zero number' } }, 400)
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
  if (!reason) {
    return c.json({ error: { code: 'bad_request', message: 'reason is required' } }, 400)
  }

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/rpc/admin_batch_adjust_credits`, {
    method: 'POST',
    headers: svc(c.env),
    body: JSON.stringify({
      p_user_ids: ids,
      p_delta: body.delta,
      p_reason: reason,
      p_actor_id: auth.userId,
    }),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string } | null
    const msg = errBody?.message ?? ''
    console.error('Batch adjust failed:', res.status, msg)
    if (/CREDIT_ACCOUNT_MISSING/.test(msg)) {
      return c.json({ error: { code: 'credit_account_missing', message: msg } }, 404)
    }
    if (/INSUFFICIENT_CREDITS/.test(msg)) {
      return c.json({ error: { code: 'insufficient_credits', message: msg } }, 409)
    }
    return c.json({ error: { code: 'upstream_error', message: 'Batch adjust failed' } }, 502)
  }
  const out = (await res.json()) as { adjusted?: number }

  await writeAudit(c.env, 'credits.adjusted', 'profiles', ids.join(','), auth.userId, {
    operation: 'batch',
    delta: body.delta,
    reason,
    user_count: ids.length,
  })
  return c.json({ ok: true, adjusted: out?.adjusted ?? ids.length, delta: body.delta })
})

// GET /api/admin/stats —— 单一聚合统计（D5 + 约束 4）
//   一次 service_role admin_stats() RPC（DB 原子快照）；storage 口径按 DB 记账估算。
// ===========================================================================
app.get('/api/admin/stats', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/rpc/admin_stats`, {
    method: 'POST',
    headers: svc(c.env),
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    console.error('Admin stats RPC failed:', res.status)
    return c.json({ error: { code: 'upstream_error', message: 'Admin stats unavailable' } }, 502)
  }
  const stats = (await res.json()) as Record<string, unknown>
  return c.json(stats)
})

// ===========================================================================
// POST /api/downloads/package —— Package（网盘）下载授权 + 扣分（Gate 10 §2.3）
//   requireUser → source 校验（enabled + host 白名单 DB 触发器已保证）→ 原子扣分
//   → 返回 url（前端 window.open）。跳转即消耗，不追退款（总纲 §46 冻结）。
//   幂等：X-Idempotency-Key 透传（同一 key 重放 → H2 返回原结果 → 再次放行同一 URL）。
//   V1.4.1（D2–D4）: 金额 = 整个 Asset 跨全部已发布语言 ready 图数
//   （基础表直查计数，口径同 published_assets.image_count，与 ?lang= 无关）
//   × package_download_cost_per_image。
//   计数/成本/金额全部服务端权威；image_count < 1 → not_available，绝不免费放行。
// ===========================================================================
interface PackageBody {
  sourceId?: unknown
}

app.post('/api/downloads/package', async (c) => {
  const auth = await requireUser(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: PackageBody
  try {
    body = await c.req.json<PackageBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const sourceId = body.sourceId
  if (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid sourceId' } }, 400)
  }

  const idemKey = c.req.header('X-Idempotency-Key')
  if (idemKey !== undefined && !UUID_RE.test(idemKey)) {
    return c.json({ error: { code: 'bad_request', message: 'X-Idempotency-Key must be a uuid' } }, 400)
  }

  // source 校验：必须 enabled 且其 asset published（RLS 同语义；service_role 直查）
  const srcRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/download_sources?id=eq.${sourceId}&select=id,provider,url,enabled,asset_id,assets!inner(status)&enabled=eq.true`,
    { headers: svc(c.env) },
  )
  if (!srcRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const srcRows = (await srcRes.json()) as Array<{
    id: string
    provider: string
    url: string
    enabled: boolean
    asset_id: string
    assets: { status: string }
  }>
  const src = srcRows[0]
  if (!src || !src.enabled || src.assets?.status !== 'published') {
    return c.json({ error: { code: 'not_found', message: 'Download source not available' } }, 404)
  }

  // V1.4.1 动态计价（D4）: 权威计数 = 整个 Asset 跨全部已发布语言的 ready 图数
  // （与 published_assets.image_count 视图同口径，与当前 ?lang= 完全解耦）。
  // 实现走基础表 service_role 直查（0001 视图 grant 仅 anon/authenticated，
  // service_role 42501——矩阵验证实证；不为此扩 grant，遵循最小变更）。
  // asset_id 源自已校验的 download_sources 行——客户端无从提交/覆盖计数或金额。
  const langRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/asset_languages?asset_id=eq.${src.asset_id}&status=eq.published&select=id`,
    { headers: svc(c.env) },
  )
  if (!langRes.ok) return c.json({ error: { code: 'internal', message: 'Language lookup failed' } }, 500)
  const langRows = (await langRes.json()) as Array<{ id: string }>
  const langIds = langRows.map((r) => r.id)
  if (langIds.length === 0) {
    return c.json({ error: { code: 'not_available', message: 'No published images available for this asset' } }, 404)
  }
  const cntRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?asset_language_id=in.(${langIds.join(',')})&status=eq.ready&select=id&limit=1`,
    { headers: { ...svc(c.env), Prefer: 'count=exact' } },
  )
  if (!cntRes.ok) return c.json({ error: { code: 'internal', message: 'Image count lookup failed' } }, 500)
  const range = cntRes.headers.get('content-range') // 例: "0-0/24"（limit=1 + count=exact）
  let imageCount = range && range.includes('/') ? Number(range.split('/')[1]) : NaN
  if (!Number.isFinite(imageCount)) {
    // 兜底：全量拉 id 计数（PostgREST max-rows 内）
    const allRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/images?asset_language_id=in.(${langIds.join(',')})&status=eq.ready&select=id`,
      { headers: svc(c.env) },
    )
    const all = allRes.ok ? ((await allRes.json()) as unknown[]) : []
    imageCount = Array.isArray(all) ? all.length : 0
  }
  if (!Number.isFinite(imageCount) || imageCount < 1) {
    // 无可下载的已发布图片 → not_available，绝不 0 成本放行
    return c.json({ error: { code: 'not_available', message: 'No published images available for this asset' } }, 404)
  }

  const costRes = await readSettingNumber(c.env, 'package_download_cost_per_image')
  if (!costRes.ok) return c.json({ error: { code: costRes.code, message: costRes.message } }, 500)
  const amount = Math.round(imageCount * costRes.value * 100) / 100
  if (!(amount > 0)) {
    return c.json({ error: { code: 'not_available', message: 'Package price unavailable' } }, 500)
  }
  const ded = await deductCredits(
    c.env, auth.userId, 'package_download', amount, idemKey ?? null,
    'download_source', sourceId,
    { provider: src.provider, asset_id: src.asset_id, image_count: imageCount, per_image_cost: costRes.value },
  )
  if (!ded.ok) {
    if (ded.code === 'insufficient_credits') {
      return c.json({ error: { code: 'insufficient_credits', message: 'Insufficient credits', required: ded.required, balance: ded.balance } }, 402)
    }
    if (ded.code === 'idempotency_conflict') {
      return c.json({ error: { code: 'idempotency_conflict', message: ded.message } }, 409)
    }
    return c.json({ error: { code: ded.code, message: ded.message } }, ded.code === 'forbidden' ? 403 : 500)
  }

  return c.json({ ok: true, url: src.url, provider: src.provider })
})

// ===========================================================================
// V1.1 PC-2: Collections admin endpoints (Gate 10 §3; 0012 + 0013 ready)
//   写路径统一走 Worker: service_role 单语句原子 + writeAudit(collection.*)
//   审计 allowlist 已含 collection.created/updated/deleted/published/archived
// ===========================================================================

interface CollectionCreateBody {
  name?: unknown
  slug?: unknown
  description?: unknown
  parentId?: unknown
}

interface CollectionUpdateBody {
  name?: unknown
  slug?: unknown
  description?: unknown
  status?: unknown
  parentId?: unknown
  /** V1.3.1 G2：封面（uuid=本合集内资产图片；null=移除；归属由 DB 守卫 COLLECTION_COVER_MISMATCH 终审） */
  coverImageId?: unknown
}

const SLUG_RE = /^[a-z0-9\u4e00-\u9fff]+(-[a-z0-9\u4e00-\u9fff]+)*$/

async function fetchCollectionRow(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/collections?id=eq.${id}&select=*`, {
    headers: svc(env),
  })
  if (!res.ok) return null
  const rows = (await res.json()) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

/** 单语句原子 PATCH（Prefer: return=representation 保证原子读回）；失败返回 null */
async function patchCollectionRow(
  env: Env,
  id: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; status: number; message: string }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/collections?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...svc(env), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    return { ok: false, status: res.status, message: body?.message ?? `update failed (${res.status})` }
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>
  if (rows.length === 0) return { ok: false, status: 404, message: 'Collection not found' }
  return { ok: true, row: rows[0]! }
}

app.post('/api/admin/collections', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: CollectionCreateBody
  try {
    body = await c.req.json<CollectionCreateBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : null
  if (!name) return c.json({ error: { code: 'bad_request', message: 'name is required' } }, 400)
  if (!slug || !SLUG_RE.test(slug)) {
    return c.json({ error: { code: 'bad_request', message: 'invalid slug' } }, 400)
  }
  // V1.2-A D1：parentId（null=根级；uuid=挂到既有集合）。存在性预检，防环/深度交给 0015 触发器
  let parentId: string | null = null
  if (body.parentId !== undefined && body.parentId !== null) {
    if (typeof body.parentId !== 'string' || !UUID_RE.test(body.parentId)) {
      return c.json({ error: { code: 'bad_request', message: 'invalid parentId' } }, 400)
    }
    const parent = await fetchCollectionRow(c.env, body.parentId)
    if (!parent) return c.json({ error: { code: 'parent_not_found', message: 'Parent collection not found' } }, 400)
    parentId = body.parentId
  }

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/collections`, {
    method: 'POST',
    headers: { ...svc(c.env), Prefer: 'return=representation' },
    body: JSON.stringify({ name, slug, description, parent_id: parentId, created_by: auth.userId }),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string; code?: string } | null
    const dup = res.status === 409 || (errBody?.code === '23505')
    if (dup) return c.json({ error: { code: 'slug_taken', message: 'Slug already exists' } }, 409)
    // V1.2-A：层级守卫触发器拒绝（parent_id 违反 FK 也会带 FK 文本）→ 明确 400
    if (/COLLECTION_COVER|COLLECTION_GUARD|COLLECTION_PARENT_SELF|COLLECTION_CYCLE|COLLECTION_DEPTH_EXCEEDED|violates foreign key/.test(errBody?.message ?? '')) {
      return c.json({ error: { code: 'collection_guard', message: errBody?.message } }, 400)
    }
    console.error('Collection create failed:', res.status, errBody?.message)
    return c.json({ error: { code: 'upstream_error', message: 'Collection create failed' } }, 502)
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return c.json({ error: { code: 'upstream_error', message: 'Collection create failed' } }, 502)

  await writeAudit(c.env, 'collection.created', 'collections', String(row.id), auth.userId, { name, slug })
  return c.json({ ok: true, collection: row })
})

app.patch('/api/admin/collections/:collectionId', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('collectionId')
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid collection id' } }, 400)
  }

  let body: CollectionUpdateBody
  try {
    body = await c.req.json<CollectionUpdateBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: { code: 'bad_request', message: 'name cannot be empty' } }, 400)
    patch.name = name
  }
  if (body.slug !== undefined) {
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
    if (!slug || !SLUG_RE.test(slug)) {
      return c.json({ error: { code: 'bad_request', message: 'invalid slug' } }, 400)
    }
    patch.slug = slug
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
  }
  if (body.status !== undefined) {
    if (body.status !== 'draft' && body.status !== 'published' && body.status !== 'archived') {
      return c.json({ error: { code: 'bad_request', message: 'invalid status' } }, 400)
    }
    patch.status = body.status
  }
  if (body.coverImageId !== undefined) {
    // V1.3.1 G2：封面写路径（此前缺失——发布门槛要求封面却无法设置）
    if (body.coverImageId === null) {
      patch.cover_image_id = null
    } else if (typeof body.coverImageId === 'string' && UUID_RE.test(body.coverImageId)) {
      patch.cover_image_id = body.coverImageId
      // V1.7.0：并存互斥——选中资产图作封面时，清掉本地上传封面（单一生效封面）
      patch.cover_source_path = null
    } else {
      return c.json({ error: { code: 'bad_request', message: 'invalid coverImageId' } }, 400)
    }
  }
  if (body.parentId !== undefined) {
    // V1.2-A D1：parentId=null 升根；uuid 换父（自引用/环/深度由 0015 触发器拒绝）
    if (body.parentId === null) {
      patch.parent_id = null
    } else if (typeof body.parentId === 'string' && UUID_RE.test(body.parentId)) {
      if (body.parentId === id) {
        return c.json({ error: { code: 'collection_guard', message: 'COLLECTION_PARENT_SELF' } }, 400)
      }
      const parent = await fetchCollectionRow(c.env, body.parentId)
      if (!parent) return c.json({ error: { code: 'parent_not_found', message: 'Parent collection not found' } }, 400)
      patch.parent_id = body.parentId
    } else {
      return c.json({ error: { code: 'bad_request', message: 'invalid parentId' } }, 400)
    }
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'nothing to update' } }, 400)
  }

  const before = await fetchCollectionRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Collection not found' } }, 404)

  const mut = await patchCollectionRow(c.env, id, patch)
  if (!mut.ok) {
    if (mut.status === 404) return c.json({ error: { code: 'not_found', message: 'Collection not found' } }, 404)
    if (mut.status === 409 || /duplicate key/.test(mut.message)) {
      return c.json({ error: { code: 'slug_taken', message: 'Slug already exists' } }, 409)
    }
    // cover 完整性 / 层级守卫触发器拒绝（COLLECTION_COVER_MISMATCH / COLLECTION_PARENT_SELF / COLLECTION_CYCLE / COLLECTION_DEPTH_EXCEEDED）→ 明确 400
    if (/COLLECTION_COVER|COLLECTION_GUARD|COLLECTION_PARENT_SELF|COLLECTION_CYCLE|COLLECTION_DEPTH_EXCEEDED/.test(mut.message)) {
      return c.json({ error: { code: 'collection_guard', message: mut.message } }, 400)
    }
    console.error('Collection patch failed:', mut.status, mut.message)
    return c.json({ error: { code: 'upstream_error', message: 'Collection update failed' } }, 502)
  }

  // 审计：status 变更记 published/archived（对齐 0012 触发器语义），其余记 updated
  const statusChanged = typeof patch.status === 'string' && patch.status !== before.status
  if (statusChanged && (patch.status === 'published' || patch.status === 'archived')) {
    await writeAudit(c.env, `collection.${patch.status}`, 'collections', id, auth.userId, {
      from: before.status,
      to: patch.status,
    })
  } else {
    await writeAudit(c.env, 'collection.updated', 'collections', id, auth.userId, {
      fields: Object.keys(patch),
    })
  }
  return c.json({ ok: true, collection: mut.row })
})

// ===========================================================================
// V1.7.0：合集封面「本地上传」（镜像站点 Logo：GitHub 独立命名空间 + collections.cover_source_path）
//   POST   /api/admin/collections/:id/cover  —— multipart(file) → collections/{id}/cover.{ext}
//   DELETE /api/admin/collections/:id/cover  —— 删 GitHub 对象 + 清 cover_source_path
//   与 cover_image_id 互斥：上传写 cover_source_path 同时清 cover_image_id（单一生效封面）。
//   零租约（每合集固定单对象、ghPutFile 幂等替换，同 Logo）；写仅 Worker service_role；requireAdmin。
// ===========================================================================

const COLLECTION_COVER_MAX_FILE_SIZE = 5 * 1024 * 1024

app.post('/api/admin/collections/:collectionId/cover', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('collectionId')
  if (!UUID_RE.test(id)) return c.json({ error: { code: 'bad_request', message: 'Invalid collection id' } }, 400)

  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'multipart/form-data body required' } }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return c.json({ error: { code: 'bad_request', message: 'file field required' } }, 400)
  }
  if (!GITHUB_MIME_EXT[file.type]) {
    return c.json({ error: { code: 'bad_request', message: `Unsupported type: ${file.type} (JPEG/PNG/WebP only)` } }, 400)
  }
  if (file.size > COLLECTION_COVER_MAX_FILE_SIZE) {
    return c.json({ error: { code: 'bad_request', message: 'File too large (max 5 MB)' } }, 413)
  }

  const before = await fetchCollectionRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Collection not found' } }, 404)

  const ext = GITHUB_MIME_EXT[file.type]
  const sourcePath = `collections/${id}/cover.${ext}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const expectedSha = await computeGitBlobSha(bytes)

  // 换扩展名时删旧封面，避免 collections/{id}/ 下残留多份
  const oldPath = typeof before.cover_source_path === 'string' ? before.cover_source_path : ''
  if (oldPath && oldPath !== sourcePath) {
    try {
      await ghDeleteFile(cfg, oldPath)
    } catch (e) {
      console.error('Old collection cover delete failed:', e)
    }
  }

  try {
    await withNetworkRetry(() => ghPutFile(cfg, sourcePath, bytes, expectedSha))
  } catch (e) {
    console.error('Collection cover upload failed:', e)
    return c.json({ error: { code: 'upstream_error', message: 'GitHub upload failed' } }, 502)
  }

  // 互斥：上传封面胜出，清掉选中的资产图封面
  const mut = await patchCollectionRow(c.env, id, { cover_source_path: sourcePath, cover_image_id: null })
  if (!mut.ok) {
    console.error('cover_source_path write failed:', mut.status, mut.message)
    return c.json({ error: { code: 'internal', message: 'Failed to persist collection cover' } }, 500)
  }

  await writeAudit(c.env, 'collection.updated', 'collections', id, auth.userId, {
    fields: ['cover_source_path'],
    cover_source_path: sourcePath,
  })
  return c.json({ ok: true, path: sourcePath })
})

app.delete('/api/admin/collections/:collectionId/cover', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('collectionId')
  if (!UUID_RE.test(id)) return c.json({ error: { code: 'bad_request', message: 'Invalid collection id' } }, 400)

  const before = await fetchCollectionRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Collection not found' } }, 404)

  const cfg = ghConfig(c.env)
  const oldPath = typeof before.cover_source_path === 'string' ? before.cover_source_path : ''

  let githubDeleted = false
  if (cfg && oldPath) {
    try {
      await ghDeleteFile(cfg, oldPath)
      githubDeleted = true
    } catch (e) {
      console.error('Collection cover GitHub delete failed:', e)
    }
  }

  const mut = await patchCollectionRow(c.env, id, { cover_source_path: null })
  if (!mut.ok) {
    console.error('cover_source_path clear failed:', mut.status, mut.message)
    return c.json({ error: { code: 'internal', message: 'Failed to clear collection cover' } }, 500)
  }

  await writeAudit(c.env, 'collection.updated', 'collections', id, auth.userId, {
    fields: ['cover_source_path'],
    cover_source_path: null,
    github_deleted: githubDeleted,
    previous_path: oldPath || null,
  })
  return c.json({ ok: true, removed: oldPath || null, github_deleted: githubDeleted })
})

app.delete('/api/admin/collections/:collectionId', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('collectionId')
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid collection id' } }, 400)
  }

  const before = await fetchCollectionRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Collection not found' } }, 404)

  // V1.2-A D3：有子集合 → 409 拒删（RESTRICT 兜底在 FK，这里是友好预检）
  const childChk = await fetch(`${c.env.SUPABASE_URL}/rest/v1/collections?parent_id=eq.${id}&select=id&limit=1`, {
    headers: svc(c.env),
  })
  if (childChk.ok) {
    const childRows = (await childChk.json()) as Array<Record<string, unknown>>
    if (childRows.length > 0) {
      return c.json({ error: { code: 'collection_has_children', message: 'Collection has child collections; move or delete them first' } }, 409)
    }
  }

  // FK assets_collection_fk ON DELETE SET NULL → 资产回归未归组（Q3：不进公域浏览）
  const del = await fetch(`${c.env.SUPABASE_URL}/rest/v1/collections?id=eq.${id}`, {
    method: 'DELETE',
    headers: svc(c.env),
  })
  if (!del.ok) {
    const errBody = (await del.json().catch(() => null)) as { message?: string } | null
    console.error('Collection delete failed:', del.status, errBody?.message)
    return c.json({ error: { code: 'upstream_error', message: 'Collection delete failed' } }, 502)
  }

  // V1.7.0：删合集后 best-effort 清理其本地上传封面对象（避免 collections/{id}/ 孤儿；行已删，仅清远端）
  const coverCfg = ghConfig(c.env)
  const coverPath = typeof before.cover_source_path === 'string' ? before.cover_source_path : ''
  if (coverCfg && coverPath) {
    await ghDeleteFile(coverCfg, coverPath).catch((e) => console.error('Collection cover cleanup on delete failed:', e))
  }

  await writeAudit(c.env, 'collection.deleted', 'collections', id, auth.userId, {
    name: before.name,
    slug: before.slug,
  })
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /api/admin/collections/assign —— 资产归组/移出（单语句原子）
//   cover 守卫：被引用为 cover 的资产移出/改判由 DB 触发器拒绝（COLLECTION_COVER_IN_USE）
// ---------------------------------------------------------------------------
interface CollectionAssignBody {
  asset_id?: unknown
  collection_id?: unknown
}

app.post('/api/admin/collections/assign', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: CollectionAssignBody
  try {
    body = await c.req.json<CollectionAssignBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const assetId = typeof body.asset_id === 'string' ? body.asset_id : ''
  if (!UUID_RE.test(assetId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid asset id' } }, 400)
  }
  // null = 移出归组（Q3 允许）；字符串 = 目标 collection
  if (body.collection_id !== null && typeof body.collection_id !== 'string') {
    return c.json({ error: { code: 'bad_request', message: 'collection_id must be a uuid or null' } }, 400)
  }
  const collectionId = typeof body.collection_id === 'string' ? body.collection_id : null
  if (collectionId !== null && !UUID_RE.test(collectionId)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid collection id' } }, 400)
  }

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/assets?id=eq.${assetId}`, {
    method: 'PATCH',
    headers: { ...svc(c.env), Prefer: 'return=representation' },
    body: JSON.stringify({ collection_id: collectionId }),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string } | null
    const msg = errBody?.message ?? `assign failed (${res.status})`
    if (res.status === 409 || /COLLECTION_COVER_IN_USE/.test(msg)) {
      return c.json({ error: { code: 'collection_guard', message: msg } }, 409)
    }
    if (res.status === 404) {
      return c.json({ error: { code: 'not_found', message: 'Asset not found' } }, 404)
    }
    console.error('Collection assign failed:', res.status, msg)
    return c.json({ error: { code: 'upstream_error', message: 'Collection assign failed' } }, 502)
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>
  if (rows.length === 0) return c.json({ error: { code: 'not_found', message: 'Asset not found' } }, 404)

  await writeAudit(c.env, 'collection.updated', 'collections', collectionId ?? '(ungroup)', auth.userId, {
    action: collectionId ? 'asset_assigned' : 'asset_removed',
    asset_id: assetId,
  })
  return c.json({ ok: true })
})

// ===========================================================================
// V1.2-B: Schedule items admin endpoints (0016; Gate docs/v1.2/01 D6-D8)
//   GET/POST/PATCH/DELETE /api/admin/schedule-items（写经 service_role 单语句原子，
//   审计 schedule.item_created/updated/deleted/published/archived —— allowlist 已扩）
//   公开读不经此端点：前端 anon 直读 published_schedule_items 视图（0016 grants）
// ===========================================================================

interface ScheduleItemCreateBody {
  title?: unknown
  description?: unknown
  eventDate?: unknown
  sortOrder?: unknown
}

interface ScheduleItemUpdateBody {
  title?: unknown
  description?: unknown
  eventDate?: unknown
  status?: unknown
  sortOrder?: unknown
  progress?: unknown
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function fetchScheduleItemRow(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/schedule_items?id=eq.${id}&select=*`, {
    headers: svc(env),
  })
  if (!res.ok) return null
  const rows = (await res.json()) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

app.get('/api/admin/schedule-items', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/schedule_items?select=*&order=event_date.asc.nullslast,sort_order.asc,created_at.asc`, {
    headers: svc(c.env),
  })
  if (!res.ok) {
    console.error('Schedule items read failed:', res.status)
    return c.json({ error: { code: 'upstream_error', message: 'Schedule items unavailable' } }, 502)
  }
  return c.json({ ok: true, items: await res.json() })
})

app.post('/api/admin/schedule-items', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: ScheduleItemCreateBody
  try {
    body = await c.req.json<ScheduleItemCreateBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return c.json({ error: { code: 'bad_request', message: 'title is required' } }, 400)
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
  let eventDate: string | null = null
  if (body.eventDate !== undefined && body.eventDate !== null) {
    if (typeof body.eventDate !== 'string' || !DATE_RE.test(body.eventDate)) {
      return c.json({ error: { code: 'bad_request', message: 'eventDate must be YYYY-MM-DD' } }, 400)
    }
    eventDate = body.eventDate
  }
  const sortOrder = typeof body.sortOrder === 'number' && Number.isInteger(body.sortOrder) ? body.sortOrder : 0

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/schedule_items`, {
    method: 'POST',
    headers: { ...svc(c.env), Prefer: 'return=representation' },
    body: JSON.stringify({ title, description, event_date: eventDate, sort_order: sortOrder, created_by: auth.userId }),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string } | null
    console.error('Schedule item create failed:', res.status, errBody?.message)
    return c.json({ error: { code: 'upstream_error', message: 'Schedule item create failed' } }, 502)
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return c.json({ error: { code: 'upstream_error', message: 'Schedule item create failed' } }, 502)

  await writeAudit(c.env, 'schedule.item_created', 'schedule_items', String(row.id), auth.userId, { title })
  return c.json({ ok: true, item: row })
})

app.patch('/api/admin/schedule-items/:itemId', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('itemId')
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid schedule item id' } }, 400)
  }

  let body: ScheduleItemUpdateBody
  try {
    body = await c.req.json<ScheduleItemUpdateBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }

  const patch: Record<string, unknown> = {}
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: { code: 'bad_request', message: 'title cannot be empty' } }, 400)
    patch.title = title
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
  }
  if (body.eventDate !== undefined) {
    if (body.eventDate === null) {
      patch.event_date = null
    } else if (typeof body.eventDate === 'string' && DATE_RE.test(body.eventDate)) {
      patch.event_date = body.eventDate
    } else {
      return c.json({ error: { code: 'bad_request', message: 'eventDate must be YYYY-MM-DD or null' } }, 400)
    }
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      return c.json({ error: { code: 'bad_request', message: 'sortOrder must be an integer' } }, 400)
    }
    patch.sort_order = body.sortOrder
  }
  if (body.status !== undefined) {
    if (body.status !== 'draft' && body.status !== 'published' && body.status !== 'archived') {
      return c.json({ error: { code: 'bad_request', message: 'invalid status' } }, 400)
    }
    patch.status = body.status
  }
  if (body.progress !== undefined) {
    // V1.3.1 G1：进度三状态（与发布态正交；DB CHECK 终审）
    if (body.progress !== 'not_started' && body.progress !== 'in_progress' && body.progress !== 'completed') {
      return c.json({ error: { code: 'bad_request', message: 'invalid progress' } }, 400)
    }
    patch.progress = body.progress
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'nothing to update' } }, 400)
  }

  const before = await fetchScheduleItemRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Schedule item not found' } }, 404)

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/schedule_items?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...svc(c.env), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string } | null
    console.error('Schedule item patch failed:', res.status, errBody?.message)
    return c.json({ error: { code: 'upstream_error', message: 'Schedule item update failed' } }, 502)
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return c.json({ error: { code: 'not_found', message: 'Schedule item not found' } }, 404)

  // 审计：status 变更记 published/archived（对齐 0016 触发器语义），其余记 updated
  const statusChanged = typeof patch.status === 'string' && patch.status !== before.status
  if (statusChanged && (patch.status === 'published' || patch.status === 'archived')) {
    await writeAudit(c.env, `schedule.item_${patch.status}`, 'schedule_items', id, auth.userId, {
      from: before.status,
      to: patch.status,
    })
  } else {
    await writeAudit(c.env, 'schedule.item_updated', 'schedule_items', id, auth.userId, {
      fields: Object.keys(patch),
    })
  }
  return c.json({ ok: true, item: row })
})

app.delete('/api/admin/schedule-items/:itemId', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const id = c.req.param('itemId')
  if (!UUID_RE.test(id)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid schedule item id' } }, 400)
  }

  const before = await fetchScheduleItemRow(c.env, id)
  if (!before) return c.json({ error: { code: 'not_found', message: 'Schedule item not found' } }, 404)

  const del = await fetch(`${c.env.SUPABASE_URL}/rest/v1/schedule_items?id=eq.${id}`, {
    method: 'DELETE',
    headers: svc(c.env),
  })
  if (!del.ok) {
    const errBody = (await del.json().catch(() => null)) as { message?: string } | null
    console.error('Schedule item delete failed:', del.status, errBody?.message)
    return c.json({ error: { code: 'upstream_error', message: 'Schedule item delete failed' } }, 502)
  }

  await writeAudit(c.env, 'schedule.item_deleted', 'schedule_items', id, auth.userId, {
    title: before.title,
  })
  return c.json({ ok: true })
})

// ===========================================================================
// V1.1 PC-3/PC-6: Site settings admin endpoints (0011: 写仅 service_role)
//   GET  /api/admin/settings      —— 全量读取（admin 面板初始化）
//   PATCH /api/admin/settings     —— 部分更新（仅允许 5 个已知 key；settings.updated 审计）
//   公开读不经此端点：前端 anon 直读 site_settings（0011 grants）
// ===========================================================================

const SETTING_KEYS = [
  'registration_enabled',
  'schedule_navigation_enabled',
  'single_image_download_cost',
  'zip_download_cost_per_image',
  'package_download_cost_per_image',
  'brand_text',
  'brand_title',
  'brand_logo_path',
] as const

const BOOLEAN_KEYS = new Set(['registration_enabled', 'schedule_navigation_enabled'])
// V1.4.1: package_download_cost_per_image（020）替代旧固定键 package_download_cost
// （旧键按 D1 裁决保留 DB 行作回滚兼容，但代码零读写、移出 PATCH 名单）
const NUMBER_KEYS = new Set(['single_image_download_cost', 'zip_download_cost_per_image', 'package_download_cost_per_image'])
// V1.4 字符串 key：brand_text/brand_title 1..60；brand_logo_path 允许空串（移除 logo）且 ≤200
const STRING_KEYS = new Set(['brand_text', 'brand_title', 'brand_logo_path'])
const STRING_MAX: Record<string, number> = {
  brand_text: 60,
  brand_title: 60,
  brand_logo_path: 200,
}

app.get('/api/admin/settings', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/site_settings?select=key,value`, {
    headers: svc(c.env),
  })
  if (!res.ok) {
    console.error('Settings read failed:', res.status)
    return c.json({ error: { code: 'upstream_error', message: 'Settings unavailable' } }, 502)
  }
  const rows = (await res.json()) as Array<{ key: string; value: unknown }>
  const out: Record<string, unknown> = {}
  for (const r of rows) out[r.key] = r.value
  return c.json({ ok: true, settings: out })
})

interface SettingsPatchBody {
  settings?: unknown
}

app.patch('/api/admin/settings', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  let body: SettingsPatchBody
  try {
    body = await c.req.json<SettingsPatchBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }
  if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
    return c.json({ error: { code: 'bad_request', message: 'settings object required' } }, 400)
  }
  const incoming = body.settings as Record<string, unknown>

  // 校验：只允许已知 key；boolean/number 类型按 key 白名单判定；数字须为非负整数
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) {
      return c.json({ error: { code: 'bad_request', message: `unknown setting key: ${k}` } }, 400)
    }
    if (BOOLEAN_KEYS.has(k)) {
      if (typeof v !== 'boolean') {
        return c.json({ error: { code: 'bad_request', message: `setting ${k} must be boolean` } }, 400)
      }
      patch[k] = v
    } else if (NUMBER_KEYS.has(k)) {
      // V1.4.1: 放宽为非负数、最多两位小数（numeric(12,2)）——Package per-image 支持 0.5
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000000 || Math.round(v * 100) !== v * 100) {
        return c.json({ error: { code: 'bad_request', message: `setting ${k} must be a non-negative number with up to 2 decimals` } }, 400)
      }
      patch[k] = v
    } else if (STRING_KEYS.has(k)) {
      if (typeof v !== 'string') {
        return c.json({ error: { code: 'bad_request', message: `setting ${k} must be a string` } }, 400)
      }
      const trimmed = v.trim()
      const max = STRING_MAX[k] ?? 200
      // brand_logo_path 允许空串（移除 logo）；其余字符串 key 不得为空
      if (k !== 'brand_logo_path' && trimmed.length === 0) {
        return c.json({ error: { code: 'bad_request', message: `setting ${k} must not be empty` } }, 400)
      }
      if (trimmed.length > max) {
        return c.json({ error: { code: 'bad_request', message: `setting ${k} exceeds ${max} chars` } }, 400)
      }
      patch[k] = trimmed
    }
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'no settings to update' } }, 400)
  }

  // 逐 key PATCH（site_settings 主键 KV；trigger 维护 updated_at；updated_by 由 Worker 落审计记录）
  for (const [k, v] of Object.entries(patch)) {
    const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/site_settings?key=eq.${encodeURIComponent(k)}`, {
      method: 'PATCH',
      headers: svc(c.env),
      body: JSON.stringify({ value: v, updated_by: auth.userId }),
    })
    if (!res.ok) {
      console.error('Settings update failed:', k, res.status)
      return c.json({ error: { code: 'upstream_error', message: `Settings update failed: ${k}` } }, 502)
    }
  }

  await writeAudit(c.env, 'settings.updated', 'site_settings', 'platform', auth.userId, {
    keys: Object.keys(patch),
    values: patch,
  })
  return c.json({ ok: true, settings: patch })
})

// ===========================================================================
// V1.4 站点品牌 Logo（GitHub 图仓库；复用 ghPutFile/ghDeleteFile）
//   POST   /api/admin/branding/logo  —— multipart(file) → branding/logo.{ext} → settings
//   DELETE /api/admin/branding/logo  —— 删 GitHub + 清空 brand_logo_path
//   写仅 Worker service_role；新端点 requireAdmin（Gate §7 红线圈）
// ===========================================================================

const BRANDING_MAX_FILE_SIZE = 1 * 1024 * 1024

/** 读取当前 brand_logo_path（供旧图替换时删除 / DELETE 时清理） */
async function readBrandLogoPath(env: Env): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.brand_logo_path&select=value`, {
    headers: svc(env),
  })
  if (!res.ok) return ''
  const rows = (await res.json()) as Array<{ value: unknown }>
  const v = rows[0]?.value
  return typeof v === 'string' ? v : ''
}

/** 写 brand_logo_path（0019 已种子该 key；PATCH 0 行则 POST 兜底） */
async function writeBrandLogoPath(env: Env, userId: string, path: string): Promise<void> {
  const patch = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.brand_logo_path`, {
    method: 'PATCH',
    headers: svc(env),
    body: JSON.stringify({ value: path, updated_by: userId }),
  })
  if (patch.ok) return
  const ins = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings`, {
    method: 'POST',
    headers: svc(env),
    body: JSON.stringify({ key: 'brand_logo_path', value: path, updated_by: userId }),
  })
  if (!ins.ok) throw new Error(`brand_logo_path write failed: ${ins.status}`)
}

app.post('/api/admin/branding/logo', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'multipart/form-data body required' } }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return c.json({ error: { code: 'bad_request', message: 'file field required' } }, 400)
  }
  if (!GITHUB_MIME_EXT[file.type]) {
    return c.json({ error: { code: 'bad_request', message: `Unsupported type: ${file.type} (JPEG/PNG/WebP only)` } }, 400)
  }
  if (file.size > BRANDING_MAX_FILE_SIZE) {
    return c.json({ error: { code: 'bad_request', message: 'File too large (max 1 MB)' } }, 413)
  }

  const ext = GITHUB_MIME_EXT[file.type]
  const sourcePath = `branding/logo.${ext}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const expectedSha = await computeGitBlobSha(bytes)

  // 旧 logo 不同扩展名则先删（避免 branding/ 下残留多份）
  const oldPath = await readBrandLogoPath(c.env)
  if (oldPath && oldPath !== sourcePath) {
    try {
      await ghDeleteFile(cfg, oldPath)
    } catch (e) {
      console.error('Old brand logo delete failed:', e)
    }
  }

  try {
    await withNetworkRetry(() => ghPutFile(cfg, sourcePath, bytes, expectedSha))
  } catch (e) {
    console.error('Brand logo upload failed:', e)
    return c.json({ error: { code: 'upstream_error', message: 'GitHub upload failed' } }, 502)
  }

  try {
    await writeBrandLogoPath(c.env, auth.userId, sourcePath)
  } catch (e) {
    console.error('brand_logo_path write failed:', e)
    return c.json({ error: { code: 'internal', message: 'Failed to persist branding setting' } }, 500)
  }

  await writeAudit(c.env, 'settings.updated', 'site_settings', 'platform', auth.userId, {
    brand_logo_path: sourcePath,
  })
  return c.json({ ok: true, path: sourcePath })
})

app.delete('/api/admin/branding/logo', async (c) => {
  const auth = await requireAdmin(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  const oldPath = await readBrandLogoPath(c.env)

  // best-effort 删除 GitHub 对象（配置缺失或无旧图时跳过）
  let githubDeleted = false
  if (cfg && oldPath) {
    try {
      await ghDeleteFile(cfg, oldPath)
      githubDeleted = true
    } catch (e) {
      console.error('Brand logo GitHub delete failed:', e)
    }
  }

  try {
    await writeBrandLogoPath(c.env, auth.userId, '')
  } catch (e) {
    console.error('brand_logo_path clear failed:', e)
    return c.json({ error: { code: 'internal', message: 'Failed to clear branding setting' } }, 500)
  }

  await writeAudit(c.env, 'settings.updated', 'site_settings', 'platform', auth.userId, {
    brand_logo_path: '',
    github_deleted: githubDeleted,
    previous_path: oldPath || null,
  })
  return c.json({ ok: true, removed: oldPath || null, github_deleted: githubDeleted })
})

// ===========================================================================
// V1.8.0 用户头像（GitHub 图仓库；复用 ghPutFile/ghDeleteFile + Logo/封面范式）
//   POST   /api/me/avatar  —— multipart(file) → avatars/{userId}/avatar.{ext} → profiles.avatar_url(raw URL)
//   DELETE /api/me/avatar  —— 删 GitHub 对象 + 清 profiles.avatar_url
//   鉴权 requireUser：任何登录用户（含 admin）仅能管理【自己】的头像（userId 取自 JWT，非入参）。
//   字节由前端 Cropper.js 裁剪为定尺寸方形后上传；零租约（每人固定单对象、ghPutFile 幂等替换）。
//   写仅 Worker service_role；profiles.avatar_url 列 0001 既有（text/nullable），无需改表。
// ===========================================================================

const AVATAR_MAX_FILE_SIZE = 2 * 1024 * 1024

/** 读取本人当前 avatar_url（供旧图换扩展名时删除 / DELETE 时清理；无行或非字符串返回 ''） */
async function readProfileAvatarUrl(env: Env, userId: string): Promise<string> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=avatar_url`,
    { headers: svc(env) },
  )
  if (!res.ok) return ''
  const rows = (await res.json()) as Array<{ avatar_url: unknown }>
  const v = rows[0]?.avatar_url
  return typeof v === 'string' ? v : ''
}

/** PATCH 本人 profiles.avatar_url（service_role；0 行视为未找到 → 抛错由调用方转 500） */
async function patchProfileAvatarUrl(env: Env, userId: string, url: string | null): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...svc(env), Prefer: 'return=representation' },
    body: JSON.stringify({ avatar_url: url }),
  })
  if (!res.ok) throw new Error(`avatar_url write failed: ${res.status}`)
  const rows = (await res.json()) as unknown[]
  if (rows.length === 0) throw new Error('avatar_url write matched 0 rows')
}

/** 从 raw URL 反推仓库内相对路径（非本仓库前缀 → 返回 ''，视为外部/历史链接不删 GitHub 对象） */
function avatarPathFromUrl(cfg: GithubConfig, url: string): string {
  const base = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/`
  return url.startsWith(base) ? url.slice(base.length) : ''
}

app.post('/api/me/avatar', async (c) => {
  const auth = await requireUser(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  if (!cfg) return githubNotConfigured(c)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'multipart/form-data body required' } }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return c.json({ error: { code: 'bad_request', message: 'file field required' } }, 400)
  }
  if (!GITHUB_MIME_EXT[file.type]) {
    return c.json({ error: { code: 'bad_request', message: `Unsupported type: ${file.type} (JPEG/PNG/WebP only)` } }, 400)
  }
  if (file.size > AVATAR_MAX_FILE_SIZE) {
    return c.json({ error: { code: 'bad_request', message: 'File too large (max 2 MB)' } }, 413)
  }

  const ext = GITHUB_MIME_EXT[file.type]
  const sourcePath = `avatars/${auth.userId}/avatar.${ext}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const expectedSha = await computeGitBlobSha(bytes)

  // 换扩展名时删旧头像，避免 avatars/{userId}/ 下残留多份
  const oldUrl = await readProfileAvatarUrl(c.env, auth.userId)
  const oldPath = avatarPathFromUrl(cfg, oldUrl)
  if (oldPath && oldPath !== sourcePath) {
    try {
      await ghDeleteFile(cfg, oldPath)
    } catch (e) {
      console.error('Old avatar delete failed:', e)
    }
  }

  try {
    await withNetworkRetry(() => ghPutFile(cfg, sourcePath, bytes, expectedSha))
  } catch (e) {
    console.error('Avatar upload failed:', e)
    return c.json({ error: { code: 'upstream_error', message: 'GitHub upload failed' } }, 502)
  }

  const url = githubRawUrl(cfg, sourcePath)
  try {
    await patchProfileAvatarUrl(c.env, auth.userId, url)
  } catch (e) {
    console.error('avatar_url write failed:', e)
    return c.json({ error: { code: 'internal', message: 'Failed to persist avatar' } }, 500)
  }

  await writeAudit(c.env, 'profile.updated', 'profiles', auth.userId, auth.userId, {
    fields: ['avatar_url'],
    avatar_path: sourcePath,
  })
  return c.json({ ok: true, url, path: sourcePath })
})

app.delete('/api/me/avatar', async (c) => {
  const auth = await requireUser(c)
  if (!auth.ok) return c.json({ error: authErrBody(auth) }, auth.status)

  const cfg = ghConfig(c.env)
  const oldUrl = await readProfileAvatarUrl(c.env, auth.userId)
  const oldPath = cfg ? avatarPathFromUrl(cfg, oldUrl) : ''

  let githubDeleted = false
  if (cfg && oldPath) {
    try {
      await ghDeleteFile(cfg, oldPath)
      githubDeleted = true
    } catch (e) {
      console.error('Avatar GitHub delete failed:', e)
    }
  }

  try {
    await patchProfileAvatarUrl(c.env, auth.userId, null)
  } catch (e) {
    console.error('avatar_url clear failed:', e)
    return c.json({ error: { code: 'internal', message: 'Failed to clear avatar' } }, 500)
  }

  await writeAudit(c.env, 'profile.updated', 'profiles', auth.userId, auth.userId, {
    fields: ['avatar_url'],
    avatar_url: null,
    github_deleted: githubDeleted,
    previous_path: oldPath || null,
  })
  return c.json({ ok: true, removed: oldPath || null, github_deleted: githubDeleted })
})

// ===========================================================================
// V1.1 PC-5: Registration Gate —— 公开注册入口，服务端 gate registration_enabled
//   PD-1：Worker 只 gate + 建号，绝不建会话 / 不回传 token；注册成功后前端复用
//         supabase.auth.signInWithPassword 建立会话（沿用现有登录链路，AuthProvider 零改动）。
//   PD-3（已批 A）：残余风险——anon key 直连 GoTrue /signup 仍可绕过本 gate；
//         本轮接受、不硬关（绝对关闭需 GoTrue 侧禁用公开 signup，属生产鉴权配置、单独授权）。
//   建号走 service_role（仅 Worker 内存）；profiles + user_roles('user') 由 handle_new_user 触发器自动创建。
// ===========================================================================

interface RegisterBody {
  email?: unknown
  password?: unknown
}

/** 服务端密码规则：与 src/lib/validators.ts validatePassword 保持一致（改一处须同步另一处） */
function passwordRuleOk(pw: string): boolean {
  if (pw.length < 8) return false
  const classes = [/[0-9]/, /[A-Z]/, /[a-z]/].filter((re) => re.test(pw)).length
  return classes >= 2
}

app.post('/api/auth/register', async (c) => {
  let body: RegisterBody
  try {
    body = await c.req.json<RegisterBody>()
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (email.length === 0 || email.length > 256 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: { code: 'invalid_input', message: 'Invalid email' } }, 400)
  }
  if (!passwordRuleOk(password)) {
    return c.json({ error: { code: 'invalid_input', message: 'Weak password' } }, 400)
  }

  // gate：实时读 registration_enabled（jsonb boolean）；读失败不放行（fail-closed）
  let enabled = false
  try {
    const res = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/site_settings?key=eq.registration_enabled&select=value`,
      { headers: svc(c.env) },
    )
    if (!res.ok) {
      console.error('register: settings read failed', res.status)
      return c.json({ error: { code: 'upstream_error', message: 'Settings unavailable' } }, 502)
    }
    const rows = (await res.json()) as Array<{ value: unknown }>
    enabled = rows[0]?.value === true
  } catch {
    return c.json({ error: { code: 'upstream_error', message: 'Settings unavailable' } }, 502)
  }
  if (!enabled) {
    return c.json({ error: { code: 'registration_disabled', message: 'Registration is currently unavailable' } }, 403)
  }

  // 建号（不建会话、不回传 token）；email_confirm:true 沿用 GoTrue 现状（未开邮箱确认 → 注册即登录）
  try {
    const cu = await fetch(`${c.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: svc(c.env),
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    if (!cu.ok) {
      // 不区分"邮箱已存在/其它失败"，统一通用错误（防枚举）
      console.error('register: admin.createUser failed', cu.status)
      return c.json({ error: { code: 'registration_failed', message: 'Registration failed' } }, 400)
    }
    return c.json({ ok: true }, 200)
  } catch (e) {
    console.error('register: threw', e)
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
  }
})

// ===========================================================================
// GET /api/img/{repoPath}?w=&q= —— V1.9.0 P0-1 图片缩放/代理接缝（公开、只读）
//   目的：把「展示缩略图」从直链 raw.githubusercontent（原图全量字节，大陆访问不稳）
//   收敛到本 Worker 单一出口，未来接 CDN / 缩放只改这一处。
//   策略：
//     · env.IMG（Cloudflare Image Resizing 绑定）存在 → 按 w/q 缩放 + format:auto 回传字节；
//     · 否则 → 302 直链原图（当前生产账户未开通 Image Resizing 时的安全回退，零功能损失）。
//   安全：仅放行 assets/ | collections/ | branding/ | avatars/ 前缀 + 图片扩展名，
//   拒绝 .. 与绝对/查询注入；w∈[16,2000]、q∈[1,100] 钳制。缩放响应带 30 天强缓存。
// ===========================================================================
const IMG_ALLOWED_PREFIXES = ['assets/', 'collections/', 'branding/', 'avatars/']
const IMG_ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(n, min), max)
}

app.get('/api/img/*', async (c) => {
  const owner = c.env.GITHUB_IMAGES_OWNER
  const repo = c.env.GITHUB_IMAGES_REPO
  const branch = c.env.GITHUB_IMAGES_BRANCH || 'main'
  if (!owner || !repo) {
    return c.json({ error: { code: 'internal', message: 'GitHub source not configured' } }, 502)
  }

  // 取 /api/img/ 之后的仓库相对路径（用原始 pathname 切片，避免 param 通配语义差异）
  const prefix = '/api/img/'
  const pathAfter = new URL(c.req.url).pathname
  if (!pathAfter.startsWith(prefix)) {
    return c.json({ error: { code: 'bad_request', message: 'Invalid image path' } }, 400)
  }
  let relPath = pathAfter.slice(prefix.length)
  try {
    relPath = decodeURIComponent(relPath)
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Invalid image path encoding' } }, 400)
  }
  if (
    !relPath ||
    relPath.includes('..') ||
    relPath.includes('\\') ||
    relPath.startsWith('/')
  ) {
    return c.json({ error: { code: 'forbidden', message: 'Disallowed image path' } }, 403)
  }
  if (!IMG_ALLOWED_PREFIXES.some((p) => relPath.startsWith(p))) {
    return c.json({ error: { code: 'forbidden', message: 'Disallowed image path' } }, 403)
  }
  const ext = (relPath.split('.').pop() || '').toLowerCase()
  if (!IMG_ALLOWED_EXT.includes(ext)) {
    return c.json({ error: { code: 'forbidden', message: 'Disallowed image type' } }, 403)
  }

  const width = clampInt(c.req.query('w'), 0, 16, 2000)
  const quality = clampInt(c.req.query('q'), 80, 1, 100)
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${relPath}`

  // (A) 有 Image Resizing 绑定且请求带宽度 → 缩放回传（省字节，真正的 P0-1 目标）
  if (c.env.IMG && width) {
    try {
      const built = c.env.IMG.from(rawUrl).transformed({ width, quality, format: 'auto' })
      const res = await built.response()
      const h = new Headers(res.headers)
      h.set('cache-control', 'public, max-age=2592000, immutable')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
    } catch (e) {
      console.error('img proxy: IMG.transformed failed, fallback passthrough:', e)
    }
  }

  // (B) 无绑定 / 未指定宽度 → 同源反代原图字节（不回 302，避免多一跳）：
  //     修大陆 raw.githubusercontent 可达性 + 30 天强缓存；首访字节不变，缩放留给 (A)。
  try {
    const upstream = await fetch(rawUrl, { cf: { cacheTtl: 2592000 } })
    if (upstream.ok) {
      const h = new Headers()
      const ct = upstream.headers.get('content-type')
      if (ct) h.set('content-type', ct)
      const cl = upstream.headers.get('content-length')
      if (cl) h.set('content-length', cl)
      h.set('cache-control', 'public, max-age=2592000, immutable')
      h.set('vary', 'Accept')
      return new Response(upstream.body, { status: 200, headers: h })
    }
    // 上游非 200（源缺失/限流）→ 透传状态码，交由浏览器/CDN 自然处理
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers })
  } catch (e) {
    console.error('img proxy: upstream fetch failed, fallback 302:', e)
  }
  // (C) 反代也失败 → 最后兜底 302 直链原图（功能永不因代理而中断）
  return c.redirect(rawUrl, 302)
})

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

app.onError((err, c) => {
  console.error('Unhandled worker error:', err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})

// 非 /api 请求交给静态资源层（未命中资源时按 SPA 规则返回 index.html）
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  // V1.9.0 P1-1：内容已带 hash 的静态资源 → 不可变长缓存；HTML（含 SPA 回退）→ no-cache（它引用 hash 文件名）。
  const path = new URL(c.req.url).pathname
  const ct = res.headers.get('content-type') || ''
  if (path.startsWith('/assets/')) {
    const h = new Headers(res.headers)
    h.set('cache-control', 'public, max-age=31536000, immutable')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
  if (ct.includes('text/html')) {
    const h = new Headers(res.headers)
    h.set('cache-control', 'no-cache')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
  return res
})

// PB-1: fetch + scheduled（对账 sweeper + 360 sweeper，cron 见 wrangler.toml [triggers]）
export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(reconcileSweeper(event, env, ctx))
    return reconcile360Sweeper(event, env, ctx)
  },
}
