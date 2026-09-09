// V1.5 Phase B1 部署后线上核验（零 GitHub 写入：仅 DB 行创建 + 409 校验路径，finally 级联清理）
// 用法：node scripts/v15-b1-prod-verify.mjs
import { readFileSync } from 'node:fs'

for (const f of ['.env']) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const SITE = 'https://image.acmerd.com'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const P = 'e2e10'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- V0 静态层未回归：首页仍指向既有 bundle（B1 零前端改动）----
const home = await fetch(`${SITE}/`)
const html = await home.text()
ok('V0 首页 200 + bundle index-ClhKmdK2.js 不变', home.status === 200 && html.includes('index-ClhKmdK2.js'))
const h = await fetch(`${SITE}/api/health`)
ok('V0b /api/health 200', h.status === 200)

// ---- V1 新端点已上线且鉴权门禁生效（无凭据 → 401/403）----
const ASSET_ID = crypto.randomUUID()
const other = crypto.randomUUID()
let r = await fetch(`${SITE}/api/admin/assets/${ASSET_ID}/360-sequences`)
ok('V1 未认证 GET 360-sequences → 401/403', r.status === 401 || r.status === 403, `status=${r.status}`)
r = await fetch(`${SITE}/api/admin/360-sequences/00000000-0000-4000-8000-000000000000/complete`, { method: 'POST' })
ok('V1b 未认证 POST complete → 401/403（路由已注册，非 SPA 兜底）', r.status === 401 || r.status === 403, `status=${r.status}`)

// ---- admin JWT ----
const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!login.ok) { console.error('admin login failed', login.status); process.exit(1) }
const jwt = (await login.json()).access_token
const auth = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${SITE}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const svcRest = async (path, method = 'GET', body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) }
}

try {
  // ---- V2 测试资产（service_role 直插 draft）+ 清单端点 ----
  r = await svcRest('assets', 'POST', { id: ASSET_ID, name: `${P} verify`, slug: `${P}-verify`, status: 'draft' })
  if (r.status >= 300) { console.error('asset insert failed', r.status, JSON.stringify(r.json)); process.exit(1) }
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`)
  ok('V2 清单 200 空序列 + active null', r.status === 200 && Array.isArray(r.json?.sequences) && r.json.sequences.length === 0 && r.json.active_sequence_id === null, JSON.stringify(r.json).slice(0, 120))

  // ---- V3 创建序列（仅 DB 行；不触碰 GitHub）----
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`, 'POST', { frame_count: 36 })
  const SEQ = r.json?.sequence_id
  ok('V3 创建 36 帧序列 200 + 36 帧行', r.status === 200 && !!SEQ && r.json?.frames?.length === 36, JSON.stringify(r.json).slice(0, 120))
  const fr = await svcRest(`asset_360_frames?sequence_id=eq.${SEQ}&select=id&blob_sha=is.null`)
  ok('V3b 36 帧行 pending 且 blob_sha 全空', (fr.json ?? []).length === 36)

  // ---- V4 缺帧 complete → 409（生产链路一致性，无 GitHub 写入）----
  r = await api(`/api/admin/360-sequences/${SEQ}/complete`, 'POST')
  ok('V4 缺帧 complete → 409 frames_incomplete', r.status === 409 && r.json?.error?.code === 'frames_incomplete', JSON.stringify(r.json).slice(0, 140))
  r = await api(`/api/admin/360-sequences/${SEQ}/activate`, 'POST')
  ok('V4b activate 非 ready → 409 invalid_state', r.status === 409 && r.json?.error?.code === 'invalid_state')

  // ---- V5 守卫负样本：跨资产激活（直接把序列 id 指到别的资产 → 触发器拒绝）----
  const insOther = await svcRest('assets', 'POST', { id: other, name: `${P} other`, slug: `${P}-other`, status: 'draft' })
  ok('V5a 第二测试资产插入成功', insOther.status < 300, `status=${insOther.status} ${JSON.stringify(insOther.json).slice(0, 120)}`)
  const guard = await svcRest(`assets?id=eq.${other}`, 'PATCH', { active_360_sequence_id: SEQ })
  const guardDetail = JSON.stringify(guard.json ?? '')
  ok('V5 跨资产激活被守卫触发器拒绝（360_ACTIVE_INVALID）', guard.status >= 400 && guardDetail.includes('360_ACTIVE_INVALID'), `status=${guard.status} ${guardDetail.slice(0, 140)}`)

  // ---- V6 移除 active（无 active → 幂等 ok）----
  r = await api(`/api/admin/assets/${ASSET_ID}/360`, 'DELETE')
  ok('V6 移除（无 active）幂等 200 removed=false', r.status === 200 && r.json?.removed === false, JSON.stringify(r.json).slice(0, 120))

  // ---- V7 现有能力回归：公开视图可读 ----
  const pub = await fetch(`${SUPABASE_URL}/rest/v1/published_360?select=asset_id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })
  ok('V7 published_360 视图 anon 可读（空数组或数据）', pub.status === 200, `status=${pub.status}`)
  const pubCol = await fetch(`${SUPABASE_URL}/rest/v1/published_collections?select=id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })
  ok('V7b 既有 published_collections 仍 200（回归）', pubCol.status === 200)
} finally {
  await svcRest(`assets?id=eq.${ASSET_ID}`, 'DELETE')
  await svcRest(`assets?id=eq.${other ?? ''}`, 'DELETE')
  const left = await svcRest(`asset_360_sequences?asset_id=eq.${ASSET_ID}&select=id`)
  ok('V8 e2e10 资产与序列行清零（级联）', (left.json ?? []).length === 0)
  console.log(`\n${pass} PASS / ${fail} FAIL`)
}
process.exit(fail > 0 ? 1 : 0)
