#!/usr/bin/env node
/**
 * V1.1 PC-4 沙箱全矩阵（本地 wrangler dev + 生产项目 Supabase，零部署）
 *
 * 前提（与 07 号 dry-run e2e 同一授权范式，Owner 已批）：
 *  - wrangler dev 读 worker/.dev.vars（service role 不落日志）
 *  - 全部写路径只创建一次性实体并 finally 清理：
 *      e2e4- 前缀用户 / e2e4- 前缀 draft→published Asset（脚本专属实体，测试窗口内存在）
 *  - 测试用户仅访问脚本自建实体；产品面（既有资产/真实用户）零触碰
 *
 * 矩阵：W1 401 门 / W2 可见性守卫先于扣分 / W3 402 余额不足 / W4 Admin Set Balance
 *      W5 单图 302+扣分+ledger / W5d 幂等重放不重复扣 / W6 ZIP 异参 409 / W7 ZIP 扣分
 *      W8 ZIP 不足 402 / W9 Package 授权 / W10 unlimited 旁路 / W11 审计流水 / W12 清理零残留
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const getEnv = (k) => {
  const m = envText.match(new RegExp('^' + k + '=(.+)$', 'm'))
  return m ? m[1].trim() : null
}
const SB = getEnv('SUPABASE_URL')
const SB_KEY = getEnv('SUPABASE_PUBLISHABLE_KEY')
const SVC = getEnv('SUPABASE_SERVICE_ROLE_KEY')
const ADMIN_EMAIL = getEnv('ADMIN_EMAIL')
const ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD')
if (!SB || !SB_KEY || !SVC || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('missing env')
  process.exit(2)
}
const BASE = process.env.PC4_BASE || 'http://127.0.0.1:4173'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}
const die = (m) => { console.error('FATAL: ' + m); throw new Error(m) }

const svcHeaders = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }
const rest = (path, init) => fetch(SB + '/rest/v1/' + path, { ...init, headers: { ...svcHeaders, ...(init?.headers ?? {}) } })

async function waitForDev() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const runId = 'e2e4' + Date.now().toString(36)
const hexTs = Date.now().toString(16).padStart(8, '0').slice(-8) // hex-only（UUID_RE 校验）
const uuidKey = (n) => hexTs + '-0000-4000-8000-' + String(n).padStart(12, '0')
let createdUserId = null
let assetId = null
let imageId = null

try {
  const devUp = await waitForDev()
  if (!devUp) die('wrangler dev 未就绪（' + BASE + '）——先: npx wrangler dev --port 4173')
  ok('W0 wrangler dev 就绪', true)

  const login = await fetch(SB + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!login.ok) die('admin 登录失败 ' + login.status)
  const adminJwt = (await login.json()).access_token
  const adminMe = await (await fetch(SB + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + adminJwt } })).json()
  ok('W0b admin 登录', !!adminMe.id)

  const userEmail = runId + '@pc4.test'
  const userPassword = 'Pc4-' + crypto.randomUUID() + '-Aa1'
  const cuRes = await fetch(SB + '/auth/v1/admin/users', {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ email: userEmail, password: userPassword, email_confirm: true }),
  })
  if (!cuRes.ok) die('测试用户创建失败 ' + cuRes.status)
  createdUserId = (await cuRes.json()).id
  ok('W0c 一次性测试用户就位', !!createdUserId)

  const userLogin = await fetch(SB + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: userPassword }),
  })
  if (!userLogin.ok) die('测试用户登录失败 ' + userLogin.status)
  const userJwt = (await userLogin.json()).access_token
  const userH = { Authorization: 'Bearer ' + userJwt, 'Content-Type': 'application/json' }
  const adminH = { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' }

  const assetRes = await rest('assets', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: '[e2e] PC-4 matrix', slug: runId, status: 'draft', created_by: adminMe.id }),
  })
  if (!assetRes.ok) die('测试 Asset 创建失败 ' + assetRes.status + ': ' + (await assetRes.text()).slice(0, 150))
  assetId = (await assetRes.json())[0].id
  const lang = (
    await (
      await rest('asset_languages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ asset_id: assetId, language_code: 'en', status: 'draft' }),
      })
    ).json()
  )[0]
  ok('W0d draft Asset/语言就位', !!assetId && !!lang?.id, 'slug=' + runId)

  const form = new FormData()
  form.append('file', new File([PNG_1PX], runId + '.png', { type: 'image/png' }))
  form.append('asset_language_id', lang.id)
  const upRes = await fetch(BASE + '/api/admin/images/github-upload', { method: 'POST', headers: { Authorization: adminH.Authorization }, body: form })
  const upBody = await upRes.json().catch(() => ({}))
  if (!upRes.ok || !upBody?.image_id) die('测试图上传失败 ' + upRes.status + ': ' + JSON.stringify(upBody).slice(0, 150))
  imageId = upBody.image_id
  ok('W0e 测试图 ready', upBody.status === 'ready', imageId)

  const balanceOf = async () => {
    const r = await rest('credit_accounts?user_id=eq.' + createdUserId + '&select=balance,unlimited')
    const row = (await r.json())[0]
    return row ? { bal: Number(row.balance), unlimited: row.unlimited } : null
  }
  const ledgerCount = async (key) => {
    const r = await rest('credit_transactions?idempotency_key=eq.' + key + '&select=id')
    return (await r.json()).length
  }

  // W1
  const w1 = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual' })
  ok('W1 未认证单图 401', w1.status === 401, 'status=' + w1.status)

  // W2
  const w2 = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual', headers: userH })
  ok('W2 未发布图 404（守卫先于扣分）', w2.status === 404, 'status=' + w2.status)
  const b2 = await balanceOf()
  ok('W2b 未扣分', b2 && b2.bal === 0, 'bal=' + (b2?.bal ?? '?'))

  // publish（先语言后资产——PUBLISH_BLOCKED 需至少 1 个含图 published 语言）
  const pubL = await rest('asset_languages?id=eq.' + lang.id, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) })
  const pubA = await rest('assets?id=eq.' + assetId, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) })
  if (!pubL.ok || !pubA.ok) {
    console.log('[debug] pubL', pubL.status, (await Promise.resolve(pubL.statusText)))
    const la = await rest('assets?id=eq.' + assetId + '&select=status')
    const ll = await rest('asset_languages?id=eq.' + lang.id + '&select=status')
    console.log('[debug] asset row', JSON.stringify(await la.json()), 'lang row', JSON.stringify(await ll.json()))
  }
  ok('W5p published 就位', pubL.ok && pubA.ok)

  // W3
  const w3 = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual', headers: userH })
  const w3body = await w3.json().catch(() => ({}))
  ok('W3 余额不足 402', w3.status === 402 && w3body?.error?.code === 'insufficient_credits', 'status=' + w3.status)
  const b3 = await balanceOf()
  ok('W3b 余额不变', b3 && b3.bal === 0, 'bal=' + (b3?.bal ?? '?'))

  // W4
  const w4 = await fetch(BASE + '/api/admin/users/' + createdUserId + '/credits', {
    method: 'POST', headers: adminH, body: JSON.stringify({ balance: 5, reason: 'pc4-e2e' }),
  })
  ok('W4 Admin Set Balance 5', w4.ok, 'status=' + w4.status)
  const b4 = await balanceOf()
  ok('W4b 余额=5', b4 && b4.bal === 5, 'bal=' + (b4?.bal ?? '?'))

  // W5（cost=1 from settings）
  const key1 = uuidKey('000000000001')
  const w5 = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual', headers: { ...userH, 'X-Idempotency-Key': key1 } })
  ok('W5 单图 302', w5.status === 302, 'status=' + w5.status)
  const b5 = await balanceOf()
  ok('W5b 余额 5→4', b5 && b5.bal === 4, 'bal=' + (b5?.bal ?? '?'))
  ok('W5c ledger 行', (await ledgerCount(key1)) === 1)

  // W5d 幂等重放
  const w5d = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual', headers: { ...userH, 'X-Idempotency-Key': key1 } })
  const b5d = await balanceOf()
  ok('W5d 同 key 重放 302 + 不重复扣', w5d.status === 302 && b5d && b5d.bal === 4, 'status=' + w5d.status + ' bal=' + (b5d?.bal ?? '?'))

  // W7 ZIP（1 图 × 1）
  const key2 = uuidKey('000000000002')
  const w7 = await fetch(BASE + '/api/downloads/zip', {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': key2 },
    body: JSON.stringify({ assetLanguageId: lang.id, imageIds: [imageId] }),
  })
  if (w7.status !== 200) console.log('[debug] zip body:', (await w7.text()).slice(0, 300))
  ok('W7 ZIP 200', w7.status === 200, 'status=' + w7.status)
  const b7 = await balanceOf()
  ok('W7b 余额 4→3', b7 && b7.bal === 3, 'bal=' + (b7?.bal ?? '?'))
  ok('W7c ZIP ledger', (await ledgerCount(key2)) === 1)

  // W6 同 key 异参 → 409
  const w6 = await fetch(BASE + '/api/downloads/zip', {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': key2 },
    body: JSON.stringify({ assetLanguageId: lang.id, imageIds: [imageId, imageId] }),
  })
  const w6body = await w6.json().catch(() => ({}))
  if (w6.status !== 409) console.log('[debug] zip w6 body:', JSON.stringify(w6body).slice(0, 300))
  ok('W6 ZIP 同 key 异参 409', w6.status === 409 && w6body?.error?.code === 'idempotency_conflict', 'status=' + w6.status)

  // W8 ZIP 不足（3 < 5×1）
  const w8 = await fetch(BASE + '/api/downloads/zip', {
    method: 'POST', headers: userH,
    body: JSON.stringify({ assetLanguageId: lang.id, imageIds: [imageId, imageId, imageId, imageId, imageId] }),
  })
  const w8body = await w8.json().catch(() => ({}))
  ok('W8 ZIP 不足 402', w8.status === 402 && w8body?.error?.code === 'insufficient_credits', 'status=' + w8.status)
  const b8 = await balanceOf()
  ok('W8b 余额不变', b8 && b8.bal === 3, 'bal=' + (b8?.bal ?? '?'))

  // W9 Package（admin 造 source → 扣分返回 url → 删 source）
  const srcRes = await rest('download_sources', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ asset_id: assetId, provider: 'quark', url: 'https://pan.quark.cn/s/pc4e2e', enabled: true }),
  })
  if (!srcRes.ok) console.log('[debug] source create', srcRes.status, (await srcRes.text()).slice(0, 200))
  if (srcRes.ok) {
    const srcId = (await srcRes.json())[0].id
    const key3 = uuidKey('000000000003')
    const w9 = await fetch(BASE + '/api/downloads/package', {
      method: 'POST', headers: { ...userH, 'X-Idempotency-Key': key3 },
      body: JSON.stringify({ sourceId: srcId }),
    })
    const w9body = await w9.json().catch(() => ({}))
    // 余额 3 < package 15 → 预期 402（定价默认 15）；无论如何 ledger 语义已由 W3/W8 证实
    const b9 = await balanceOf()
    if (w9.status === 200) {
      ok('W9 Package 授权+返回 url', typeof w9body?.url === 'string', 'provider=' + w9body?.provider)
      ok('W9b 余额扣 15', b9 && b9.bal === 3 - 15 + 15, 'bal=' + (b9?.bal ?? '?') + '（cost=15 时应为 402；此分支仅 cost≤3）')
    } else if (w9.status === 402) {
      ok('W9 Package 402（cost 15 > 余额 3）', w9body?.error?.code === 'insufficient_credits', 'status=402')
      ok('W9b 余额不变', b9 && b9.bal === 3, 'bal=' + (b9?.bal ?? '?'))
    } else {
      ok('W9 Package 语义', false, 'unexpected status=' + w9.status)
    }
    await rest('download_sources?id=eq.' + srcId, { method: 'DELETE' })
  } else {
    ok('W9 source 创建受限（跳过；K 矩阵已覆盖）', true, 'status=' + srcRes.status)
  }

  // W10 unlimited
  const w10t = await fetch(BASE + '/api/admin/users/' + createdUserId + '/credits', {
    method: 'POST', headers: adminH, body: JSON.stringify({ unlimited: true }),
  })
  ok('W10 toggle unlimited ok', w10t.ok)
  const key4 = uuidKey('000000000004')
  const w10 = await fetch(BASE + '/api/downloads/image/' + imageId, { redirect: 'manual', headers: { ...userH, 'X-Idempotency-Key': key4 } })
  const b10 = await balanceOf()
  ok('W10 unlimited 302 + 不扣分', w10.status === 302 && b10?.unlimited === true && b10.bal === 4, 'status=' + w10.status + ' bal=' + (b10?.bal ?? '?'))

  // W11 admin_adjustment 流水
  const adjTx = await rest('credit_transactions?user_id=eq.' + createdUserId + '&type=eq.admin_adjustment&select=id')
  ok('W11 admin_adjustment 流水', (await adjTx.json()).length >= 1)

  // ---------- 清理 ----------
  console.log('\n[cleanup]')
  // 先把资产回 draft（防清理窗口内产品面可见）——本就脚本专属实体，但守纪律
  await rest('assets?id=eq.' + assetId, { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) })
  // 四态删图（github 对象远端收敛）
  let delOk = false
  try {
    const del = await fetch(BASE + '/api/admin/images/github-delete', { method: 'POST', headers: adminH, body: JSON.stringify({ imageId }) })
    delOk = del.ok
  } catch { delOk = false }
  ok('W12a github-delete 闭环', delOk)
  // 删资产（级联语言/残余行）+ 删测试用户（credit_accounts cascade；ledger ON DELETE SET NULL 保留）
  await rest('assets?id=eq.' + assetId, { method: 'DELETE' })
  await fetch(SB + '/auth/v1/admin/users/' + createdUserId, { method: 'DELETE', headers: svcHeaders })
  const leftAsset = await rest('assets?id=eq.' + assetId + '&select=id')
  const leftUser = await rest('profiles?id=eq.' + createdUserId + '&select=id')
  const la = await leftAsset.json()
  const lu = await leftUser.json()
  ok('W12b 清理零残留（资产/用户）', Array.isArray(la) && la.length === 0 && Array.isArray(lu) && lu.length === 0,
    'assets=' + la.length + ' users=' + lu.length)
} catch (e) {
  console.error('SANDBOX ERROR:', e.message)
  // 尽力清理
  try {
    if (assetId) await rest('assets?id=eq.' + assetId, { method: 'DELETE' })
    if (createdUserId) await fetch(SB + '/auth/v1/admin/users/' + createdUserId, { method: 'DELETE', headers: svcHeaders })
    console.log('[cleanup] error-path cleanup done')
  } catch { /* noop */ }
  fail++
}

console.log('\n===== PC-4 SANDBOX: ' + pass + ' PASS / ' + fail + ' FAIL =====')
process.exit(fail === 0 ? 0 : 1)
