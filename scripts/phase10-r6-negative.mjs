#!/usr/bin/env node
// Phase 10 · R6 Permission Regression（L-B 生产负样本）—— 五类越权全部必须 FAIL-EXPECTED
// 执行方式：set -a && . ./.env && set +a && node scripts/phase10-r6-negative.mjs
// 红线：不回显 secret/token/密码；一次性用户 e2e10.r6.* 前缀，finally 删除 + 级联 + 反向查询 0 残留；
//       负样本判定 = 状态码非 2xx，或「2xx 但回读确认未变/空集」双证；不触碰任何既有真实行。
const BASE = process.env.WORKER_BASE || 'https://image.acmerd.com'
const SB = process.env.SUPABASE_URL.replace(/\/$/, '')
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const PREFIX = 'e2e10.r6.'

if (!SB || !SVC || !PUB || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('FATAL: missing env'); process.exit(2)
}
let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}
async function jfetch(url, init = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const txt = await res.text(); let body = null
    try { body = txt ? JSON.parse(txt) : null } catch { body = txt }
    return { status: res.status, body, raw: txt }
  } finally { clearTimeout(t) }
}
const rand = () => Math.random().toString(36).slice(2, 10)
const adminDomain = ADMIN_EMAIL.includes('@') ? ADMIN_EMAIL.split('@')[1] : 'example.com'
const jsonHeaders = (token) => ({ 'content-type': 'application/json', apikey: PUB, Authorization: `Bearer ${token ?? ''}` })
const DENY = (s) => s < 200 || s >= 300 // 非 2xx 即拒绝

let tempUserId = null, tempEmail = null, tempJwt = null

async function cleanup() {
  console.log('\n--- cleanup（零残留断言）---')
  if (tempUserId) {
    const r = await jfetch(`${SB}/auth/v1/admin/users/${tempUserId}`, { method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    check(`R6-Z1 删除一次性用户 → ${r.status}`, r.status === 200 || r.status === 204)
  }
  // D1 附加约束：反向查询确认 0 残留（不是"删除 API 成功"即罢）
  const p = await jfetch(`${SB}/rest/v1/profiles?email=like.${encodeURIComponent(PREFIX + '*')}&select=id`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  const u = await jfetch(`${SB}/rest/v1/user_roles?select=user_id&limit=1000`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  const a = await jfetch(`${SB}/auth/v1/admin/users?per_page=200&query=${encodeURIComponent(PREFIX)}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  const pArr = Array.isArray(p.body) ? p.body : []
  const remaining = Array.isArray(u.body) ? u.body.filter((x) => x.user_id === tempUserId).length : -1
  const authHits = a.body?.users?.filter((x) => (x.email || '').startsWith(PREFIX)).length ?? -1
  check('R6-Z2 反向查询 profiles 前缀残留 = 0', pArr.length === 0, `got ${pArr.length}`)
  check('R6-Z3 反向查询 user_roles 该用户残留 = 0', remaining === 0, `got ${remaining}`)
  check('R6-Z4 反向查询 auth.users 前缀残留 = 0', authHits === 0, `got ${authHits}`)
}

try {
  console.log('=== Phase 10 · R6 Permission Regression（生产负样本，全部必须 FAIL-EXPECTED）===')

  // R6-1 Guest → Admin（无 JWT 打 Worker admin API）
  console.log('\n--- R6-1 Guest → Admin（无 JWT）---')
  for (const [name, url, init] of [
    ['GET /api/admin/users', `${BASE}/api/admin/users`, {}],
    ['GET /api/admin/stats', `${BASE}/api/admin/stats`, {}],
    ['POST /api/admin/users/{id}/role', `${BASE}/api/admin/users/00000000-0000-0000-0000-000000000000/role`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) }],
    ['POST /api/admin/users/{id}/disabled', `${BASE}/api/admin/users/00000000-0000-0000-0000-000000000000/disabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) }],
    ['POST /api/admin/storage/delete', `${BASE}/api/admin/storage/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x/y/z' }) }],
  ]) {
    const r = await jfetch(url, init)
    check(`R6-1 ${name} → ${r.status}（期望 401）`, r.status === 401, `status=${r.status} body=${String(r.raw).slice(0, 80)}`)
  }

  // R6-2 Guest（anon key）→ PostgREST 写路径 + 敏感读
  console.log('\n--- R6-2 Guest → DB / Storage ---')
  const anonH = { apikey: PUB } // 无 Authorization = anon 角色
  let r = await jfetch(`${SB}/rest/v1/assets`, { method: 'POST', headers: { ...anonH, 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ slug: `e2e10-anon-${rand()}`, title: 'x' }) })
  check(`R6-2a anon INSERT assets → 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  r = await jfetch(`${SB}/rest/v1/user_roles`, { method: 'POST', headers: { ...anonH, 'content-type': 'application/json' }, body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000', role: 'admin' }) })
  check(`R6-2b anon INSERT user_roles → 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  r = await jfetch(`${SB}/rest/v1/audit_logs`, { method: 'POST', headers: { ...anonH, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'x' }) })
  check(`R6-2c anon INSERT audit_logs → 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  r = await jfetch(`${SB}/rest/v1/audit_logs?select=action&limit=5`, { headers: anonH })
  check(`R6-2d anon SELECT audit_logs → 空集（${r.status}, ${Array.isArray(r.body) ? r.body.length : 'N/A'} 行）`, r.status === 200 && Array.isArray(r.body) && r.body.length === 0)
  // Storage：anon 直写 images 桶
  r = await jfetch(`${SB}/storage/v1/object/images/e2e10-anon-${rand()}.png`, { method: 'POST', headers: { ...anonH, 'content-type': 'image/png', 'x-upsert': 'false' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
  check(`R6-2e anon Storage 上传 images 桶 → 拒绝（${r.status}）`, DENY(r.status), String(r.raw).slice(0, 100))

  // 一次性用户（user 身份）
  console.log('\n--- 一次性用户创建 ---')
  tempEmail = `${PREFIX}${rand()}@${adminDomain}`
  const tempPassword = `P10e2e_${rand()}${rand()}` // 不打印
  const mk = await jfetch(`${SB}/auth/v1/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: SVC, Authorization: `Bearer ${SVC}` },
    body: JSON.stringify({ email: tempEmail, password: tempPassword, email_confirm: true }),
  })
  check('R6-0a 创建一次性用户 → 200', mk.status === 200, mk.raw?.slice(0, 120))
  tempUserId = mk.body?.id ?? null
  const l = await jfetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: tempEmail, password: tempPassword }) })
  check('R6-0b 一次性用户登录 → 200', l.status === 200, l.raw?.slice(0, 120))
  tempJwt = l.body?.access_token ?? null
  if (!tempJwt) throw new Error('temp user login failed')

  // R6-3 USER → Admin（user JWT 打 Worker admin API → 期望 403）
  console.log('\n--- R6-3 USER → Admin（非管理员 JWT）---')
  for (const [name, url, init] of [
    ['GET /api/admin/users', `${BASE}/api/admin/users`, {}],
    ['GET /api/admin/stats', `${BASE}/api/admin/stats`, {}],
    ['POST role 提权', `${BASE}/api/admin/users/${tempUserId}/role`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) }],
    ['POST disabled 自保改写', `${BASE}/api/admin/users/${tempUserId}/disabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: false }) }],
    ['POST storage/delete', `${BASE}/api/admin/storage/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x/y/z' }) }],
  ]) {
    const r = await jfetch(url, { ...init, headers: { ...(init.headers || {}), ...jsonHeaders(tempJwt) } })
    check(`R6-3 ${name} → ${r.status}（期望 403）`, r.status === 403, `status=${r.status} body=${String(r.raw).slice(0, 100)}`)
  }

  // R6-4 USER → DB 写路径 / 敏感读（PostgREST 直连）
  console.log('\n--- R6-4 USER → DB ---')
  const userH = { apikey: PUB, Authorization: `Bearer ${tempJwt}` }
  r = await jfetch(`${SB}/rest/v1/assets`, { method: 'POST', headers: { ...userH, 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ slug: `e2e10-usr-${rand()}`, title: 'x' }) })
  check(`R6-4a user INSERT assets → 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  // UPDATE 既有行：用真实列 name；RLS 拒绝表现为非 2xx，若 2xx 必须回读双证未变
  const pubAssets = await jfetch(`${SB}/rest/v1/published_assets?select=id,slug&limit=1`, { headers: userH })
  const target = Array.isArray(pubAssets.body) ? pubAssets.body[0] : null
  if (target) {
    const before = await jfetch(`${SB}/rest/v1/assets?select=name&id=eq.${target.id}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    const beforeName = Array.isArray(before.body) ? before.body[0]?.name : null
    r = await jfetch(`${SB}/rest/v1/assets?id=eq.${target.id}`, { method: 'PATCH', headers: { ...userH, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'hacked-by-r6' }) })
    const after = await jfetch(`${SB}/rest/v1/assets?select=name&id=eq.${target.id}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    const afterName = Array.isArray(after.body) ? after.body[0]?.name : null
    const hardDenied = DENY(r.status)
    check(`R6-4b user UPDATE 他人 assets → 拒绝（写返回 ${r.status}${hardDenied ? '，硬拒绝' : `，2xx 回读 name before="${beforeName}" after="${afterName}" 未变`}`,
      hardDenied ? true : (afterName === beforeName && beforeName !== 'hacked-by-r6'),
      `before=${beforeName} after=${afterName}`)
  } else {
    check('R6-4b user UPDATE 他人 assets（无可用 published asset，记 N/A）', true)
  }
  r = await jfetch(`${SB}/rest/v1/user_roles`, { method: 'POST', headers: { ...userH, 'content-type': 'application/json' }, body: JSON.stringify({ user_id: tempUserId, role: 'admin' }) })
  check(`R6-4c user INSERT user_roles（自我提权）→ 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  r = await jfetch(`${SB}/rest/v1/audit_logs`, { method: 'POST', headers: { ...userH, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'x' }) })
  check(`R6-4d user INSERT audit_logs → 拒绝（${r.status}）`, DENY(r.status), r.raw?.slice(0, 100))
  r = await jfetch(`${SB}/rest/v1/audit_logs?select=action&limit=5`, { headers: userH })
  check(`R6-4e user SELECT audit_logs → 空集（${Array.isArray(r.body) ? r.body.length : 'N/A'} 行）`, r.status === 200 && Array.isArray(r.body) && r.body.length === 0)
  r = await jfetch(`${SB}/rest/v1/rpc/admin_user_mutation`, { method: 'POST', headers: { ...userH, 'content-type': 'application/json' }, body: JSON.stringify({ p_actor: tempUserId, p_target: tempUserId, p_role: 'admin' }) })
  check(`R6-4f user 直调 admin_user_mutation RPC → 拒绝（${r.status}，函数仅授权 service_role）`, DENY(r.status), r.raw?.slice(0, 120))
  // Storage：user 直写 images 桶
  r = await jfetch(`${SB}/storage/v1/object/images/e2e10-usr-${rand()}.png`, { method: 'POST', headers: { ...userH, 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
  check(`R6-4g user Storage 上传 images 桶 → 拒绝（${r.status}）`, DENY(r.status), String(r.raw).slice(0, 100))

  // R6-5 disabled 门禁发布复验（Phase 7 S8 语义：有效 JWT 但 disabled → 403 account_disabled）
  console.log('\n--- R6-5 disabled 门禁 ---')
  const adminLogin = await jfetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) })
  check('R6-5a admin 登录 → 200', adminLogin.status === 200)
  const dis = await jfetch(`${BASE}/api/admin/users/${tempUserId}/disabled`, { method: 'POST', headers: jsonHeaders(adminLogin.body.access_token), body: JSON.stringify({ disabled: true }) })
  check(`R6-5b admin 禁用一次性用户 → 2xx（${dis.status}）`, dis.status >= 200 && dis.status < 300, String(dis.raw).slice(0, 120))
  r = await jfetch(`${BASE}/api/admin/stats`, { headers: jsonHeaders(tempJwt) })
  check(`R6-5c disabled 用户带有效 JWT 打 admin API → 403 account_disabled（${r.status}）`, r.status === 403 && String(r.raw).includes('account_disabled'), `status=${r.status} body=${String(r.raw).slice(0, 100)}`)
  r = await jfetch(`${BASE}/api/downloads/zip`, { method: 'POST', headers: { ...jsonHeaders(tempJwt), 'content-type': 'application/json' }, body: JSON.stringify({ assetId: '00000000-0000-0000-0000-000000000000', imageIds: [] }) })
  check(`R6-5d disabled 用户打下载端点 → 403 account_disabled（${r.status}）`, r.status === 403 && String(r.raw).includes('account_disabled'), `status=${r.status} body=${String(r.raw).slice(0, 100)}`)
} catch (e) {
  console.error('ABORT:', e.message)
} finally {
  await cleanup()
  console.log(`\n=== R6 结果: PASS=${pass} FAIL=${fail} ===`)
  process.exit(fail > 0 ? 1 : 0)
}
