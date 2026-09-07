// V1.2-A 多层 Folder：Worker 集成层沙箱验证（设计 Gate docs/v1.2/01 D1–D3）
// 前置：本地 wrangler dev（端口 8787，.dev.vars 指生产 Supabase——与 PC-7 生产核验同范式，
//       e2e7 前缀 + finally 清零；审计行留痕符合既有惯例）。
// 用法：node node_modules/wrangler/wrangler-dist/cli.js dev --port 8787  另开终端后跑本脚本。
// 层级/视图语义终审在 DB 触发器（隔离库冒烟 13/13 已证），本脚本验证 Worker 接线与错误映射。
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}

const BASE = process.env.WORKER_BASE ?? 'http://127.0.0.1:8787'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const P = 'e2e7'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- admin JWT（GoTrue password grant，凭据不落输出）----
const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!loginRes.ok) { console.error('admin login failed', loginRes.status); process.exit(1) }
const jwt = (await loginRes.json()).access_token
const auth = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const cleanup = async () => {
  // 深度优先删除（RESTRICT：必须先删子）
  const res = await fetch(`${SUPABASE_URL}/rest/v1/collections?slug=like.${P}-*&select=id,slug`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  })
  const rows = (await res.json().catch(() => [])) ?? []
  for (const slug of rows.map((r) => r.slug).sort((a, b) => b.split('-').length - a.split('-').length || b.localeCompare(a))) {
    await fetch(`${SUPABASE_URL}/rest/v1/collections?slug=eq.${slug}`, {
      method: 'DELETE',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    })
  }
}
await cleanup()

// ---- W1 根级创建：parent_id=null ----
let r = await api('/api/admin/collections', 'POST', { name: `${P} Root`, slug: `${P}-root` })
ok('W1 根级创建 200 + parent_id=null', r.status === 200 && r.json?.collection?.parent_id === null, JSON.stringify(r.json).slice(0, 120))
const root = r.json?.collection?.id

// ---- W2 挂父创建 + parent_not_found ----
r = await api('/api/admin/collections', 'POST', { name: `${P} Child`, slug: `${P}-child`, parentId: root })
ok('W2 挂父创建 200 + parent_id=root', r.status === 200 && r.json?.collection?.parent_id === root, JSON.stringify(r.json).slice(0, 120))
const child = r.json?.collection?.id
r = await api('/api/admin/collections', 'POST', { name: `${P} G3`, slug: `${P}-g3`, parentId: child })
const g3 = r.json?.collection?.id
ok('W2a 三层链创建 200', r.status === 200 && !!g3)
r = await api('/api/admin/collections', 'POST', { name: `${P} Bad`, slug: `${P}-bad`, parentId: '11111111-1111-4111-8111-111111111111' })
ok('W2b parentId 不存在 → 400 parent_not_found', r.status === 400 && r.json?.error?.code === 'parent_not_found', JSON.stringify(r.json).slice(0, 120))

// ---- W3 深度上限：链到 5 层 OK，第 6 层 400 collection_guard ----
r = await api('/api/admin/collections', 'POST', { name: `${P} G4`, slug: `${P}-g4`, parentId: g3 })
const g4 = r.json?.collection?.id
r = await api('/api/admin/collections', 'POST', { name: `${P} G5`, slug: `${P}-g5`, parentId: g4 })
const g5 = r.json?.collection?.id
ok('W3a 第 5 层允许', r.status === 200 && !!g5, JSON.stringify(r.json).slice(0, 120))
r = await api('/api/admin/collections', 'POST', { name: `${P} G6`, slug: `${P}-g6`, parentId: g5 })
ok('W3b 第 6 层 → 400 collection_guard(DEPTH)', r.status === 400 && r.json?.error?.code === 'collection_guard' && /DEPTH/.test(r.json?.error?.message ?? ''), JSON.stringify(r.json).slice(0, 160))

// ---- W4 守卫：自引用 / 环 / 升根 ----
r = await api(`/api/admin/collections/${root}`, 'PATCH', { parentId: root })
ok('W4a 自引用 → 400 collection_guard', r.status === 400 && r.json?.error?.code === 'collection_guard', JSON.stringify(r.json).slice(0, 120))
r = await api(`/api/admin/collections/${root}`, 'PATCH', { parentId: child })
ok('W4b 环（root→child）→ 400 collection_guard(CYCLE)', r.status === 400 && r.json?.error?.code === 'collection_guard' && /CYCLE/.test(r.json?.error?.message ?? ''), JSON.stringify(r.json).slice(0, 160))
r = await api(`/api/admin/collections/${child}`, 'PATCH', { parentId: null })
ok('W4c 升根 200 + parent_id=null', r.status === 200 && r.json?.collection?.parent_id === null, JSON.stringify(r.json).slice(0, 120))

// ---- W5 删父预检：有子 → 409；无子 → 200 ----
// （W4c 已把 child 升根：root 无子、child 挂着 g3→g4→g5 链）
r = await api(`/api/admin/collections/${child}`, 'DELETE')
ok('W5a 有子删父 → 409 collection_has_children', r.status === 409 && r.json?.error?.code === 'collection_has_children', JSON.stringify(r.json).slice(0, 120))
r = await api(`/api/admin/collections/${root}`, 'DELETE')
ok('W5b 无子删除 200', r.status === 200, JSON.stringify(r.json).slice(0, 120))

// ---- W6 深树换父拒绝（子树随迁超限）----
// root(g3链) + 新链 c1..c4（深4），把 g3(带子) 挂到 c4 → 6 层拒
r = await api('/api/admin/collections', 'POST', { name: `${P} C1`, slug: `${P}-c1` })
const c1 = r.json?.collection?.id
r = await api('/api/admin/collections', 'POST', { name: `${P} C2`, slug: `${P}-c2`, parentId: c1 })
const c2 = r.json?.collection?.id
r = await api('/api/admin/collections', 'POST', { name: `${P} C3`, slug: `${P}-c3`, parentId: c2 })
const c3 = r.json?.collection?.id
r = await api('/api/admin/collections', 'POST', { name: `${P} C4`, slug: `${P}-c4`, parentId: c3 })
const c4 = r.json?.collection?.id
r = await api(`/api/admin/collections/${g3}`, 'PATCH', { parentId: c4 })
ok('W6 深树换父超限 → 400 collection_guard(DEPTH)', r.status === 400 && r.json?.error?.code === 'collection_guard' && /DEPTH/.test(r.json?.error?.message ?? ''), JSON.stringify(r.json).slice(0, 160))

// ---- W7 清零复核 ----
await cleanup()
const chk = await fetch(`${SUPABASE_URL}/rest/v1/collections?slug=like.${P}-*&select=id`, {
  headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
})
const residual = ((await chk.json()) ?? []).length
ok('W7 e2e7 零残留', residual === 0, `residual=${residual}`)

console.log(`\n===== V1.2-A WORKER SANDBOX: ${pass} PASS / ${fail} FAIL =====`)
process.exit(fail === 0 ? 0 : 1)
