#!/usr/bin/env node
/**
 * V1.1 PC-5 Registration Gate —— 本地沙箱验证（本地 wrangler dev + 生产 Supabase/GitHub，零部署）
 *
 * 授权范式同 PC-4：全部写路径只创建一次性 e2e5- 前缀实体并 finally 清理；产品面零触碰。
 * 覆盖：
 *   R1 registration_enabled=true → POST /api/auth/register 有效 → 200 {ok:true}（经 Worker 建号）
 *   R1b E2E：GoTrue password-grant 登录该用户 → 200 session（证明 Worker 建号 + email_confirm:true 生效，即 PD-1 链路）
 *   R2 弱密码 → 400 invalid_input（服务端校验，客户端可绕过时的兜底）
 *   R3 非法邮箱 → 400 invalid_input
 *   R4 重复邮箱 → 400 registration_failed（通用错误、不泄露"已存在"，防枚举）
 *   R5 清理零残留：admin 列表扫 e2e5%pc5.test == 0
 * 说明：403 registration_disabled 分支为代码级验证（不擅自翻转生产全局 registration_enabled 做运行时探测）。
 *
 * 前置：先起 worker（见 scripts/_pc4-runner.sh 同款：node node_modules/wrangler/.../cli.js dev --port 8787），
 *      设 PC5_BASE=http://127.0.0.1:8787。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const getEnv = (k) => (envText.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim() ?? null
const SB = getEnv('SUPABASE_URL')
const SB_KEY = getEnv('SUPABASE_PUBLISHABLE_KEY')
const SVC = getEnv('SUPABASE_SERVICE_ROLE_KEY')
if (!SB || !SB_KEY || !SVC) { console.error('missing env'); process.exit(2) }
const BASE = process.env.PC5_BASE || 'http://127.0.0.1:8787'
const svcH = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const runId = 'e2e5' + Date.now().toString(36)
const email = runId + '@pc5.test'
const pw = 'Pc5-' + randomUUID().replace(/-/g, '').slice(0, 8) + 'Aa1' // ≥8 且含大小写数字
let createdId = null

async function findUserIdByEmail(em) {
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${SB}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: svcH })
    if (!res.ok) return null
    const js = await res.json()
    const users = js.users || js || []
    const hit = users.find((u) => (u.email || '').toLowerCase() === em.toLowerCase())
    if (hit) return hit.id
    if (users.length < 1000) break
  }
  return null
}

const reg = (body) =>
  fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

try {
  // worker 就绪
  let up = false
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch {} await new Promise((r) => setTimeout(r, 500)) }
  ok('V0 wrangler dev 就绪', up)
  if (!up) throw new Error('worker 未就绪：先跑 _pc4-runner.sh 同款并设 PC5_BASE')

  // R1 有效注册 → 200 {ok:true}
  const r1 = await reg({ email, password: pw })
  const b1 = await r1.json().catch(() => ({}))
  ok('R1 registration_enabled=true 有效注册 200', r1.status === 200 && b1.ok === true, 'status=' + r1.status)
  createdId = await findUserIdByEmail(email)
  ok('R1b 用户已由 Worker 建号（admin 列表可见）', !!createdId, 'id=' + (createdId || '—'))

  // R1c E2E：GoTrue password-grant 登录（PD-1 链路：注册→直接可登录，email_confirm:true）
  const lr = await fetch(SB + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  })
  const lj = await lr.json().catch(() => ({}))
  ok('R1c E2E 登录建立会话（PD-1 方案 A 成立）', lr.status === 200 && !!lj.access_token, 'status=' + lr.status)

  // R2 弱密码 → 400 invalid_input
  const r2 = await reg({ email: 'e2e5weak-' + runId + '@pc5.test', password: 'abc' })
  const b2 = await r2.json().catch(() => ({}))
  ok('R2 弱密码 400 invalid_input', r2.status === 400 && b2.error?.code === 'invalid_input', 'status=' + r2.status + ' code=' + b2.error?.code)

  // R3 非法邮箱 → 400 invalid_input
  const r3 = await reg({ email: 'not-an-email', password: pw })
  const b3 = await r3.json().catch(() => ({}))
  ok('R3 非法邮箱 400 invalid_input', r3.status === 400 && b3.error?.code === 'invalid_input', 'status=' + r3.status + ' code=' + b3.error?.code)

  // R4 重复邮箱 → 400 registration_failed（通用、防枚举）
  const r4 = await reg({ email, password: pw })
  const b4 = await r4.json().catch(() => ({}))
  ok('R4 重复邮箱 400 registration_failed（防枚举）', r4.status === 400 && b4.error?.code === 'registration_failed', 'status=' + r4.status + ' code=' + b4.error?.code)
} catch (e) {
  console.error('FATAL', e)
  fail++
} finally {
  if (createdId) {
    await fetch(`${SB}/auth/v1/admin/users/${createdId}`, { method: 'DELETE', headers: svcH })
  }
  const left = await findUserIdByEmail(email)
  ok('R5 清理零残留（e2e5%pc5.test）', !left, left ? '仍存 ' + left : 'gone')
}

console.log('\n===== PC-5 VERIFY: ' + pass + ' PASS / ' + fail + ' FAIL =====')
process.exit(fail === 0 ? 0 : 1)
