// V1.8.0：用户头像上传端点生产功能实走（默认打本地 wrangler dev，亦可用 ACCEPT_BASE 指向线上）。
// 覆盖：鉴权/类型/大小校验；上传 png→落 profiles.avatar_url(raw)+GitHub 对象可读；
//       换扩展名 jpeg→旧 png 对象删；移除→对象删 + 列清空；无凭据 401。
// 隔离：仅操作【当前登录用户自己】的头像（userId 取自 JWT）；快照原值(须为 null)，finally 删除净零。
import { readFileSync } from 'node:fs'
for (const f of ['.env', '.dev.vars']) {
  try {
    for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  } catch {
    /* 文件缺失忽略 */
  }
}
const SITE = process.env.ACCEPT_BASE ?? 'http://localhost:8787'
const U = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const GH_API = `https://api.github.com/repos/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}`
const GH_H = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'v18-avatar-live-verify' }
const RAW_BASE = `https://raw.githubusercontent.com/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}/${process.env.GITHUB_IMAGES_BRANCH}/`

// 1x1 PNG / 1x1 JPEG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64')

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name) } else { fail++; console.log('  FAIL ', name, detail) } }

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!login.ok) { console.error('login failed', login.status, await login.text()); process.exit(1) }
const lj = await login.json()
const jwt = lj.access_token
const uid = lj.user.id
const AUTH = { Authorization: `Bearer ${jwt}` }
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}` }

const api = async (path, method, body, withAuth = true) => {
  const headers = withAuth ? AUTH : undefined
  const res = await fetch(`${SITE}${path}`, { method, headers, body })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const dbAvatar = async () => (await (await fetch(`${U}/rest/v1/profiles?id=eq.${uid}&select=avatar_url`, { headers: svcH })).json())[0]?.avatar_url ?? null
// 权威存在性：GitHub Contents API（源真值，非 raw CDN 缓存）→ 200 存在 / 404 已删
const ghHead = async (path) => (await fetch(`${GH_API}/contents/${encodeURI(path)}?ref=${process.env.GITHUB_IMAGES_BRANCH}`, { headers: GH_H })).status
const form = (type, bytes, name) => { const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name); return fd }

const original = await dbAvatar()
console.log(`目标用户: ${uid}\n站点: ${SITE}\n原 avatar_url: ${JSON.stringify(original)}`)
if (original !== null) {
  console.error('原 avatar_url 非空——为避免破坏既有数据，中止。请先清空后重试。')
  process.exit(2)
}

try {
  // A0 无凭据 → 401
  let r = await api('/api/me/avatar', 'POST', form('image/png', PNG, 'a.png'), false)
  ok('A0 无凭据上传 → 401', r.status === 401, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)

  // A1 上传 png
  r = await api('/api/me/avatar', 'POST', form('image/png', PNG, 'a.png'))
  const pngPath = `avatars/${uid}/avatar.png`
  ok('A1 上传 png → 200 + path/url', r.status === 200 && r.json?.ok === true && r.json?.path === pngPath && r.json?.url === RAW_BASE + pngPath, `${r.status} ${JSON.stringify(r.json)}`)
  ok('A1b DB avatar_url = raw URL', (await dbAvatar()) === RAW_BASE + pngPath)
  ok('A1c GitHub png 对象存在(200)', (await ghHead(pngPath)) === 200)

  // A2 换扩展名 jpeg → 旧 png 删、新 jpeg 存、DB 更新
  r = await api('/api/me/avatar', 'POST', form('image/jpeg', JPG, 'b.jpg'))
  const jpgPath = `avatars/${uid}/avatar.jpg`
  ok('A2 上传 jpeg → 200 + path', r.status === 200 && r.json?.path === jpgPath, `${r.status} ${JSON.stringify(r.json)}`)
  ok('A2b DB avatar_url 指向 jpeg', (await dbAvatar()) === RAW_BASE + jpgPath)
  ok('A2c 旧 png 对象已删(404)', (await ghHead(pngPath)) === 404)
  ok('A2d jpeg 对象存在(200)', (await ghHead(jpgPath)) === 200)

  // A3 非法类型 → 400
  r = await api('/api/me/avatar', 'POST', form('image/gif', PNG, 'x.gif'))
  ok('A3 不支持类型 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)

  // A4 超大（>2MB）→ 413
  r = await api('/api/me/avatar', 'POST', form('image/png', Buffer.alloc(3 * 1024 * 1024, 1), 'big.png'))
  ok('A4 超过 2MB → 413', r.status === 413, `${r.status} ${JSON.stringify(r.json?.error ?? '')}`)

  // A5 移除 → 200 + 对象删 + 列 null
  r = await api('/api/me/avatar', 'DELETE')
  ok('A5 移除 → 200 ok', r.status === 200 && r.json?.ok === true, `${r.status} ${JSON.stringify(r.json)}`)
  ok('A5b DB avatar_url = null', (await dbAvatar()) === null)
  ok('A5c jpeg 对象已删(404)', (await ghHead(jpgPath)) === 404)

  // A6 幂等移除（无头像再删）→ 仍 200
  r = await api('/api/me/avatar', 'DELETE')
  ok('A6 无头像时移除仍 200', r.status === 200 && r.json?.ok === true, `${r.status} ${JSON.stringify(r.json)}`)
} finally {
  await api('/api/me/avatar', 'DELETE').catch(() => {})
  let residual = 0
  for (const ext of ['png', 'jpg', 'webp']) {
    if ((await ghHead(`avatars/${uid}/avatar.${ext}`)) === 200) { residual++; console.log('  WARN  残留对象:', `avatars/${uid}/avatar.${ext}`) }
  }
  ok('R0 收尾 avatar_url 回到原值(null)', (await dbAvatar()) === null)
  ok('R1 GitHub 零残留', residual === 0, `residual=${residual}`)
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}
