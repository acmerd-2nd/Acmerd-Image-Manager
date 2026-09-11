// V1.7.0：合集封面「本地上传」生产功能实走（隔离 draft 合集，不触碰任何真实资产/合集）
// 覆盖：上传→落 cover_source_path 且清 cover_image_id + GitHub 对象可公开读；
//       换扩展名上传→旧 GitHub 对象被删；移除→对象删 + 列清空；删合集→封面对象 best-effort 清理；
//       anon 读 published_collections 视图含 cover_source_path 键。finally 删合集 + GitHub 兜底核对零残留。
// 注：合集 id 由服务端生成（Worker POST /collections 不收客户端 id），故先创建再取真实 id。
import { readFileSync } from 'node:fs'
for (const f of ['.env', '.dev.vars']) {
  for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const SITE = process.env.ACCEPT_BASE ?? 'https://image.acmerd.com'
const U = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const GH_API = `https://api.github.com/repos/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}`
const GH_H = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'v17-cover-live-verify' }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
// 1x1 JPEG
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64')

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name) } else { fail++; console.log('  FAIL ', name, detail) } }

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) })
if (!login.ok) { console.error('login failed', login.status); process.exit(1) }
const jwt = (await login.json()).access_token
const AUTH = { Authorization: `Bearer ${jwt}` }
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}` }

const api = async (path, method, body) => {
  const res = await fetch(`${SITE}${path}`, { method, headers: body instanceof FormData ? AUTH : { ...AUTH, 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : (body === undefined ? undefined : JSON.stringify(body)) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const dbRow = async (id) => (await (await fetch(`${U}/rest/v1/collections?id=eq.${id}&select=id,cover_image_id,cover_source_path`, { headers: svcH })).json())[0] ?? null
// 权威存在性：GitHub Contents API（源真值，非 raw CDN 缓存）→ 200 存在 / 404 已删
const ghHead = async (path) => (await fetch(`${GH_API}/contents/${encodeURI(path)}?ref=${process.env.GITHUB_IMAGES_BRANCH}`, { headers: GH_H })).status
const coverForm = (type, bytes, name) => { const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name); return fd }

let cid = ''
const slug = `e2e-cov-${crypto.randomUUID().slice(0, 6)}`
let lastPath = ''

try {
  // K0 创建隔离 draft 合集（id 服务端生成）
  let r = await api('/api/admin/collections', 'POST', { name: 'e2e-cov 封面验证', slug })
  cid = r.json?.collection?.id ?? ''
  ok('K0 建隔离 draft 合集（取服务端 id）', r.status < 300 && !!cid, `${r.status} ${JSON.stringify(r.json?.error ?? r.json ?? '')}`)

  if (cid) {
    // 1) 上传 png
    r = await api(`/api/admin/collections/${cid}/cover`, 'POST', coverForm('image/png', PNG, 'a.png'))
    lastPath = `collections/${cid}/cover.png`
    ok('K1 上传 png → 200 + path', r.status === 200 && r.json?.ok === true && r.json?.path === lastPath, `${r.status} ${JSON.stringify(r.json)}`)
    let row = await dbRow(cid)
    ok('K1b DB cover_source_path 落库、cover_image_id 为 null', row?.cover_source_path === lastPath && row?.cover_image_id === null, JSON.stringify(row))
    ok('K1c GitHub 封面对象公开可读(200)', (await ghHead(lastPath)) === 200)

    // 2) 换扩展名上传 jpeg → 旧 png 应被删
    r = await api(`/api/admin/collections/${cid}/cover`, 'POST', coverForm('image/jpeg', JPG, 'b.jpg'))
    const jpgPath = `collections/${cid}/cover.jpg`
    lastPath = jpgPath
    ok('K2 换上传 jpeg → 200 + path=cover.jpg', r.status === 200 && r.json?.path === jpgPath, JSON.stringify(r.json))
    ok('K2b 旧 png 对象已删(404)', (await ghHead(`collections/${cid}/cover.png`)) === 404)
    ok('K2c 新 jpg 对象可读(200)', (await ghHead(jpgPath)) === 200)
    row = await dbRow(cid)
    ok('K2d DB cover_source_path=cover.jpg', row?.cover_source_path === jpgPath)

    // 3) 移除上传封面
    r = await api(`/api/admin/collections/${cid}/cover`, 'DELETE')
    ok('K3 移除 → 200 + github_deleted', r.status === 200 && r.json?.ok === true && r.json?.github_deleted === true, JSON.stringify(r.json))
    ok('K3b GitHub 对象已删(404)', (await ghHead(jpgPath)) === 404)
    row = await dbRow(cid)
    ok('K3c DB cover_source_path 清空', row?.cover_source_path === null)

    // 4) anon 读 published_collections 视图含 cover_source_path 键（证明视图透出该列，只读不改）
    const anonRows = await (await fetch(`${U}/rest/v1/published_collections?select=id,slug,cover_source_path&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })).json()
    ok('K4 anon 视图可读且含 cover_source_path 键', Array.isArray(anonRows) && (anonRows.length === 0 || 'cover_source_path' in anonRows[0]), JSON.stringify(anonRows).slice(0, 120))

    // 5) 再上传，然后删合集 → 封面对象应被 best-effort 清理
    r = await api(`/api/admin/collections/${cid}/cover`, 'POST', coverForm('image/png', PNG, 'c.png'))
    const png2 = `collections/${cid}/cover.png`
    lastPath = png2
    ok('K5 再上传 png → 200', r.status === 200 && r.json?.path === png2)
    r = await api(`/api/admin/collections/${cid}`, 'DELETE')
    ok('K5b 删合集 → 200', r.status === 200 && r.json?.ok === true, `${r.status} ${JSON.stringify(r.json)}`)
    ok('K5c 删合集后封面 GitHub 对象已清理(404)', (await ghHead(png2)) === 404)
  }
} finally {
  // 兜底：按真实 id 删合集；再按 slug 兜底清残留（防早期脚本遗留）
  if (cid) await api(`/api/admin/collections/${cid}`, 'DELETE').catch(() => {})
  const slugLeft = (await (await fetch(`${U}/rest/v1/collections?slug=eq.${slug}&select=id`, { headers: svcH })).json()) ?? []
  for (const c of slugLeft) await api(`/api/admin/collections/${c.id}`, 'DELETE').catch(() => {})
  const gone = (await dbRow(cid || '00000000-0000-0000-0000-000000000000')) === null && slugLeft.length === 0
  ok('Z1 隔离合集已删除（零残留）', gone)
  if (lastPath) ok('Z2 GitHub 无残留封面对象', (await ghHead(lastPath)) === 404, `path=${lastPath}`)
  console.log(`\n${pass} PASS / ${fail} FAIL`)
}
process.exit(fail > 0 ? 1 : 0)
