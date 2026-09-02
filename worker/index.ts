import { Hono } from 'hono'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  /** 仅存于 Worker Secret，绝不进入前端 bundle（总纲铁律） */
  SUPABASE_SERVICE_ROLE_KEY?: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: 'acmerd-image-manager', time: new Date().toISOString() }),
)

// ---------------------------------------------------------------------------
// 高权限 Storage 删除端点（Phase 3，Owner 指定通道）
//
// 设计：
//   * 浏览器只携带自己的普通登录 JWT（admin），无任何高权限凭据
//   * Worker 校验 JWT 有效且角色为 admin 后，用 Worker Secret 里的
//     Service Role Key 调 Storage 批量删除 —— 密钥不出服务器
//   * 只接受「精确对象路径」：images/{asset_uuid}/{lang}/{filename}
//     （实测 Storage 的 {prefixes} 目录删除不递归、list 有缓存延迟，
//      精确路径删除是唯一可靠方式；前端从 images 表收集路径传入）
// ---------------------------------------------------------------------------

interface StorageDeleteBody {
  paths?: unknown
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LANGS = ['en', 'de', 'it', 'fr', 'es']

function isValidImagePath(p: string): boolean {
  if (typeof p !== 'string' || p.length > 512 || p.includes('..')) return false
  const parts = p.split('/')
  // images/{asset_uuid}/{lang}/{filename}
  if (parts.length !== 4) return false
  return (
    parts[0] === 'images' &&
    UUID_RE.test(parts[1]) &&
    LANGS.includes(parts[2]) &&
    parts[3].length > 0
  )
}

async function requireAdmin(c: { req: { header: (k: string) => string | undefined }; env: Env }) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false as const, status: 401 as const, message: 'Missing bearer token' }
  }
  const jwt = auth.slice(7)

  // 1. JWT 有效性：交给 Supabase Auth 验证（不自己解签，杜绝伪造）
  const userRes = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: c.env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  })
  if (!userRes.ok) {
    return { ok: false as const, status: 401 as const, message: 'Invalid or expired token' }
  }
  const user = (await userRes.json()) as { id?: string }
  if (!user.id) {
    return { ok: false as const, status: 401 as const, message: 'Invalid user payload' }
  }

  // 2. 角色校验：user_roles 表（service role 只读查询，绝不下发）
  const roleRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
    {
      headers: {
        apikey: c.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    },
  )
  if (!roleRes.ok) {
    return { ok: false as const, status: 500 as const, message: 'Role lookup failed' }
  }
  const roles = (await roleRes.json()) as Array<{ role: string }>
  if (!roles.some((r) => r.role === 'admin')) {
    return { ok: false as const, status: 403 as const, message: 'Admin required' }
  }

  return { ok: true as const, userId: user.id }
}

app.post('/api/admin/storage/delete', async (c) => {
  if (!c.env.SUPABASE_SERVICE_ROLE_KEY) {
    return c.json(
      { error: { code: 'not_configured', message: 'Service role key not configured on worker' } },
      500,
    )
  }

  const auth = await requireAdmin(c)
  if (!auth.ok) {
    return c.json({ error: { code: 'unauthorized', message: auth.message } }, auth.status)
  }

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

  // Storage 删除：endpoint 已限定 bucket=images，prefixes 须为 bucket 内相对路径
  // （前端传入的路径带 bucket 名，与 DB images.storage_path 约定一致，这里剥掉首段）
  const relativePaths = (paths as string[]).map((p) => p.split('/').slice(1).join('/'))
  const authHeaders = {
    apikey: c.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }

  try {
    // 精确路径删除，每批最多 100 个
    for (let i = 0; i < relativePaths.length; i += 100) {
      const batch = relativePaths.slice(i, i + 100)
      const delRes = await fetch(`${c.env.SUPABASE_URL}/storage/v1/object/images`, {
        method: 'DELETE',
        headers: authHeaders,
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

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

app.onError((err, c) => {
  console.error('Unhandled worker error:', err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})

// 非 /api 请求交给静态资源层（未命中资源时按 SPA 规则返回 index.html）
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
