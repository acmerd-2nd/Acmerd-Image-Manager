import { Hono } from 'hono'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  /** 仅存于 Worker Secret，绝不进入前端 bundle（总纲铁律） */
  SUPABASE_SERVICE_ROLE_KEY?: string
  ASSETS: Fetcher
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
    `${c.env.SUPABASE_URL}/rest/v1/images?id=eq.${imageId}&select=id,storage_path,filename,asset_languages!inner(status,assets!inner(status))`,
    { headers: svc(c.env) },
  )
  if (!res.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const rows = (await res.json()) as Array<{
    id: string
    storage_path: string
    filename: string
    asset_languages: { status: string; assets: { status: string } }
  }>
  const img = rows[0]
  const lang = img?.asset_languages
  if (!img || !lang || lang.status !== 'published' || lang.assets?.status !== 'published') {
    return c.json({ error: { code: 'not_found', message: 'Image not available' } }, 404)
  }

  const relative = img.storage_path.split('/').slice(1).join('/')
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

  // 2. 取图片行，强制全部属于该语言（跨语言混选拒绝）
  const inList = (imageIds as string[]).map((x) => `"${x}"`).join(',')
  const imgRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/images?select=id,filename,storage_path,file_size,sort_order&id=in.(${inList})&asset_language_id=eq.${langId}`,
    { headers: svc(c.env) },
  )
  if (!imgRes.ok) return c.json({ error: { code: 'internal', message: 'Lookup failed' } }, 500)
  const files = (await imgRes.json()) as Array<{
    id: string
    filename: string
    storage_path: string
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

  // 5. 流式打包（store 模式 + CRC32；有界预取；读失败中断流）
  const zipName = sanitizeZipName(`${lang.assets.slug}-${lang.language_code}.zip`)
  const stream = buildZipStream(c.env, files, ZIP_CONCURRENCY)
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Cache-Control': 'no-store',
    },
  })
})

// ===========================================================================
// ZIP 构建（store 模式，不压缩；每文件缓冲 ≤15MB 计算 CRC32 后写出）
// ===========================================================================
async function preflightHead(env: Env, files: { storage_path: string }[], concurrency: number) {
  let cursor = 0
  let failed = false
  async function worker() {
    while (cursor < files.length && !failed) {
      const f = files[cursor++]
      const relative = f.storage_path.split('/').slice(1).join('/')
      try {
        const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/public/images/${relative}`, {
          method: 'HEAD',
        })
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

interface ZipFile {
  filename: string
  storage_path: string
}

async function fetchObjectBytes(env: Env, f: ZipFile): Promise<Uint8Array> {
  const relative = f.storage_path.split('/').slice(1).join('/')
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/images/${relative}`, {
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

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

app.onError((err, c) => {
  console.error('Unhandled worker error:', err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})

// 非 /api 请求交给静态资源层（未命中资源时按 SPA 规则返回 index.html）
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
