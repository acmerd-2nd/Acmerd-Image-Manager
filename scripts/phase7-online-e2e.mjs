#!/usr/bin/env node
// Phase 7 · 线上 E2E（任务 #5）—— 补齐 QA 报告中 PENDING_DEPLOY 的「disabled Worker 门禁线上 HTTP」证据
// 执行方式：set -a && . ./.env && set +a && node scripts/phase7-online-e2e.mjs
// 红线：全程不回显任何 secret / token / 密码；临时用户在 finally 中删除并验证级联清理；不触碰任何既有真实行。
const BASE = process.env.WORKER_BASE || 'https://image.acmerd.com'
const SB = process.env.SUPABASE_URL.replace(/\/$/, '')
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

if (!SB || !SVC || !PUB || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('FATAL: missing env (need SUPABASE_URL/SERVICE_ROLE_KEY/PUBLISHABLE_KEY/ADMIN_EMAIL/ADMIN_PASSWORD)')
  process.exit(2)
}

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}
async function jfetch(url, init = {}, timeoutMs = 20000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    let body = null
    const txt = await res.text()
    try { body = txt ? JSON.parse(txt) : null } catch { body = txt }
    return { status: res.status, body, raw: txt }
  } finally { clearTimeout(t) }
}
const rand = () => Math.random().toString(36).slice(2, 10)
const adminDomain = ADMIN_EMAIL.includes('@') ? ADMIN_EMAIL.split('@')[1] : 'example.com'
const jsonHeaders = (token) => ({ 'content-type': 'application/json', apikey: PUB, Authorization: `Bearer ${token}` })

const created = [] // 需要清理的临时用户 uuid

async function cleanup() {
  console.log('\n--- cleanup ---')
  for (const id of created) {
    const r = await jfetch(`${SB}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    })
    check(`delete temp user ${id.slice(0, 8)}… → HTTP ${r.status}`, r.status === 200 || r.status === 204)
    if (r.status === 200 || r.status === 204) {
      const p = await jfetch(`${SB}/rest/v1/profiles?id=eq.${id}&select=id`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
      const u = await jfetch(`${SB}/rest/v1/user_roles?user_id=eq.${id}&select=user_id`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
      const pArr = Array.isArray(p.body) ? p.body : []
      const uArr = Array.isArray(u.body) ? u.body : []
      check(`cascade: profiles/user_roles 已随 auth.users 删除 (${pArr.length}/${uArr.length} 残留)`, pArr.length === 0 && uArr.length === 0)
    }
  }
  created.length = 0
}

let adminUuid = null
let jwtAdmin = null

try {
  console.log('=== Phase 7 线上 E2E（部署后） ===')
  console.log(`Worker: ${BASE} | Supabase: ${SB.replace(/https:\/\//, '')}`)

  // S0 健康检查（新 Worker 上线判别）
  const health = await jfetch(`${BASE}/api/health`)
  check('S0 /api/health = 200', health.status === 200)

  // S1 真实管理员登录
  const login = await jfetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  check('S1 admin 密码登录 → 200', login.status === 200)
  if (login.status !== 200) throw new Error('admin login failed: ' + login.raw.slice(0, 200))
  jwtAdmin = login.body.access_token

  // S2 管理端点：用户列表（自包含 envelope）
  const users = await jfetch(`${BASE}/api/admin/users?page=1&per_page=5`, { headers: jsonHeaders(jwtAdmin) })
  const usersOk = users.status === 200 && Array.isArray(users.body?.users) && typeof users.body?.total === 'number'
  check('S2 GET /api/admin/users → 200 envelope {users,total,page,per_page}', usersOk, users.raw?.slice(0, 120))
  if (usersOk) {
    const me = users.body.users.find((u) => u.email === ADMIN_EMAIL)
    adminUuid = me?.id ?? null
    check('S2.1 管理员本人在列表中 role=admin 且 disabled=false', !!me && me.role === 'admin' && me.disabled === false, JSON.stringify(me))
  }

  // S3 管理端点：stats（7 键原子快照）
  const stats = await jfetch(`${BASE}/api/admin/stats`, { headers: jsonHeaders(jwtAdmin) })
  const st = stats.body || {}
  const statsOk = stats.status === 200 && typeof st.storageUsedBytes === 'number' && typeof st.totalImages === 'number' && st.totalImages >= 0
  check('S3 GET /api/admin/stats → 200 数值快照', statsOk, stats.raw?.slice(0, 200))

  // S4 管理端点：审计直连（D4：admin JWT 经 RLS 直读 audit_logs）
  const audit = await jfetch(`${SB}/rest/v1/audit_logs?select=action,actor_id,created_at&order=created_at.desc&limit=3`, { headers: jsonHeaders(jwtAdmin) })
  check('S4 admin JWT 直连 audit_logs → 200 rows', audit.status === 200 && Array.isArray(audit.body), audit.raw?.slice(0, 120))

  // ========== 一次性临时用户 ==========
  console.log('\n--- disabled 门禁（一次性临时用户，末尾清理） ---')
  const mkUser = async (tag) => {
    const email = `phase7.e2e.${rand()}@${adminDomain}`
    const password = `P7e2e_${rand()}${rand()}` // 不打印
    const r = await jfetch(`${SB}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SVC, Authorization: `Bearer ${SVC}` },
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    if (r.status !== 200) throw new Error(`${tag} create failed: ${r.raw?.slice(0, 200)}`)
    created.push(r.body.id)
    // 登录拿 JWT（禁用前）
    const l = await jfetch(`${SB}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email, password }),
    })
    if (l.status !== 200) throw new Error(`${tag} login failed: ${l.raw?.slice(0, 200)}`)
    return { id: r.body.id, email, jwt: l.body.access_token }
  }

  const g = await mkUser('user-G')

  // S5 RLS 线上负样本：普通用户写 user_roles 被拒（B1 线上）
  const rlsNeg = await jfetch(`${SB}/rest/v1/user_roles`, {
    method: 'POST', headers: jsonHeaders(g.jwt), body: JSON.stringify({ user_id: g.id, role: 'admin' }),
  })
  check('S5 user(G) 直连写 user_roles → 403 拒绝', rlsNeg.status === 403, `HTTP ${rlsNeg.status}`)

  // S6 Worker 管理员端点：普通用户被 requireAdmin 拒
  const nonAdmin = await jfetch(`${BASE}/api/admin/users`, { headers: jsonHeaders(g.jwt) })
  check('S6 user(G) 调 /api/admin/users → 403', nonAdmin.status === 403, `HTTP ${nonAdmin.status}`)

  // S7 管理员经 Worker 禁用 G（worker→RPC 原子落库→audit→best-effort 撤会话）
  const disable = await jfetch(`${BASE}/api/admin/users/${g.id}/disabled`, {
    method: 'POST', headers: jsonHeaders(jwtAdmin), body: JSON.stringify({ disabled: true }),
  })
  const d = disable.body || {}
  check('S7 admin 经 Worker 禁用 G → 200 {disabled:true, disabled_changed:true}', disable.status === 200 && d.disabled === true && d.disabled_changed === true && d.role === 'user', disable.raw?.slice(0, 200))

  // S8 ★ disabled Worker 门禁：被禁用户的 JWT 调 /api → 403 {code:'account_disabled'}
  //   若 GoTrue /logout 已撤销会话，旧 access token 可能直接 401（先于门禁）；此时用绕过 logout 的直连 RPC 通道补第二用户证明 403 路径。
  const gate = await jfetch(`${BASE}/api/admin/users`, { headers: jsonHeaders(g.jwt) })
  const gateBody = gate.body || {}
  if (gate.status === 403 && gateBody.error?.code === 'account_disabled') {
    check('S8 ★ disabled 门禁 → 403 account_disabled（主通道：Worker 禁用后）', true)
  } else if (gate.status === 401) {
    console.log(`  注: G 禁用后旧 token 被 GoTrue 撤销 → 401（${gateBody.error?.code || 'unauthorized'}）；改用直连 RPC 通道补证 403…`)
    check('S8a 会话撤销生效（G 旧 token 401，best-effort logout 可达）', true)
    // 第二临时用户：直连 service-role RPC 禁用（不触发 GoTrue logout），保留有效会话 → 必达 403
    const g2 = await mkUser('user-G2')
    const rpc = await jfetch(`${SB}/rest/v1/rpc/admin_user_mutation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SVC, Authorization: `Bearer ${SVC}` },
      body: JSON.stringify({ p_actor: adminUuid, p_target: g2.id, p_role: null, p_disabled: true }),
    })
    check('S8b 直连 RPC 禁用 G2 → 200', rpc.status === 200 && (rpc.body || {}).disabled === true, `HTTP ${rpc.status} ${rpc.raw?.slice(0, 120)}`)
    const gate2 = await jfetch(`${BASE}/api/admin/users`, { headers: jsonHeaders(g2.jwt) })
    const gb2 = gate2.body || {}
    check('S8c ★ disabled 门禁 → 403 account_disabled（直连 RPC 通道）', gate2.status === 403 && gb2.error?.code === 'account_disabled', `HTTP ${gate2.status} ${gate2.raw?.slice(0, 150)}`)
  } else {
    check('S8 ★ disabled 门禁 → 403 account_disabled', false, `HTTP ${gate.status} ${gate.raw?.slice(0, 150)}`)
  }

  // S9 启用反向路径（管理员可重新启用 → RPC 幂等审计语义 sanity）
  const enable = await jfetch(`${BASE}/api/admin/users/${g.id}/disabled`, {
    method: 'POST', headers: jsonHeaders(jwtAdmin), body: JSON.stringify({ disabled: false }),
  })
  const en = enable.body || {}
  check('S9 admin 经 Worker 重新启用 G → 200 {disabled:false}', enable.status === 200 && en.disabled === false, enable.raw?.slice(0, 200))
} catch (e) {
  fail++
  console.error('  FATAL', e.message)
} finally {
  await cleanup()
}

console.log(`\n===== RESULT: ${pass} PASS / ${fail} FAIL =====`)
process.exit(fail === 0 ? 0 : 1)
