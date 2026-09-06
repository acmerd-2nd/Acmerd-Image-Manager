#!/usr/bin/env node
/**
 * V1.1 生产部署后验证（13 号文档 §3：V1/V4/V5/V6/V7/V9/V10；V2/V3 走浏览器单独核）
 * 凭据运行时读取（.env + G: seed 凭据文件），零密钥进 chat/log/git。e2e 实体 finally 清理。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const g = (k) => (envText.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim() ?? null
const SB = g('SUPABASE_URL'), SVC = g('SUPABASE_SERVICE_ROLE_KEY'), PUB = g('SUPABASE_PUBLISHABLE_KEY')
const ADMIN_EMAIL = g('ADMIN_EMAIL'), ADMIN_PASSWORD = g('ADMIN_PASSWORD')
const BASE = 'https://image.acmerd.com'
const svcH = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? ' — ' + e : '')) } else { fail++; console.log('  FAIL  ' + n + (e ? ' — ' + e : '')) } }

// 读 seed 凭据文件（G:），只取 demo01/demo02 的密码到内存
const credDir = process.argv[2] || 'G:\\000000.AIDIJIA'
function readSeedPassword(email) {
  const files = readdirSync(credDir).filter((f) => f.startsWith('seed-credentials-') && f.endsWith('.txt'))
  for (const f of files) {
    for (const line of readFileSync(join(credDir, f), 'utf8').split('\n')) {
      const [em, pw] = line.split('\t')
      if (em === email && pw) return pw.trim()
    }
  }
  return null
}

async function login(email, password) {
  const r = await fetch(SB + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!r.ok) return null
  return (await r.json()).access_token
}

async function balanceOf(userId) {
  const rows = await (await fetch(SB + '/rest/v1/credit_accounts?user_id=eq.' + userId + '&select=balance,unlimited', { headers: svcH })).json()
  return rows?.[0] ? { balance: Number(rows[0].balance), unlimited: !!rows[0].unlimited } : null
}

async function userIdByEmail(em) {
  const rows = await (await fetch(SB + '/auth/v1/admin/users?page=1&per_page=1000', { headers: svcH })).json()
  const hit = (rows.users || rows || []).find((u) => (u.email || '').toLowerCase() === em)
  return hit?.id ?? null
}

let e2e6Id = null
try {
  // V1 health
  const h = await fetch(BASE + '/api/health')
  ok('V1 health 200', h.status === 200, 'status=' + h.status)

  // 素材：published asset (ecosonique) 的 language + ready image + download source
  const assets = await (await fetch(SB + '/rest/v1/assets?slug=eq.ecosonique&select=id', { headers: svcH })).json()
  const assetId = assets?.[0]?.id ?? null
  const langs = await (await fetch(SB + '/rest/v1/asset_languages?asset_id=eq.' + assetId + '&status=eq.published&select=id', { headers: svcH })).json()
  const langId = langs?.[0]?.id ?? null
  const imgs = await (await fetch(SB + '/rest/v1/images?asset_language_id=eq.' + langId + '&status=eq.ready&select=id,source_path&order=sort_order.asc', { headers: svcH })).json()
  const img1 = imgs?.[0] ?? null
  const srcs = await (await fetch(SB + '/rest/v1/download_sources?asset_id=eq.' + assetId + '&enabled=eq.true&select=id', { headers: svcH })).json()
  ok('V-prep 生产素材就位', !!assetId && !!langId && !!img1, 'img=' + (img1?.id ?? '—') + ' sources=' + (srcs?.length ?? 0))

  // V4 链路：admin 设 demo01 balance=5 → demo01 单图下载 302 → 余额 5→4 → Location 指向生产 raw
  const demo01Id = await userIdByEmail('demo01@acmerd.com')
  const adminJwt = await login(ADMIN_EMAIL, ADMIN_PASSWORD)
  const setResp = await fetch(BASE + '/api/admin/users/' + demo01Id + '/credits', {
    method: 'POST', headers: { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance: 5, reason: 'pc7-deploy-verify' }),
  })
  ok('V4a admin Set Balance=5', setResp.status === 200, 'status=' + setResp.status)
  const b0 = await balanceOf(demo01Id)
  ok('V4b 余额=5', b0?.balance === 5, 'bal=' + b0?.balance)

  const demo01Pw = readSeedPassword('demo01@acmerd.com')
  const demoJwt = demo01Pw ? await login('demo01@acmerd.com', demo01Pw) : null
  ok('V4c demo01 登录（密码文件有效）', !!demoJwt)

  const idemKey = randomUUID()
  const d1 = await fetch(BASE + '/api/downloads/image/' + img1.id, {
    headers: { Authorization: 'Bearer ' + demoJwt, 'X-Idempotency-Key': idemKey }, redirect: 'manual',
  })
  const loc = d1.headers.get('location') || ''
  ok('V4d 单图 302', d1.status === 302, 'status=' + d1.status)
  ok('V4e Location 指向生产 raw（URL 正确性）', loc.includes('raw.githubusercontent.com/acmerd-2nd/-Photo-Acmerd-Image-Manager/main/assets/'), loc.slice(0, 90) + '…')
  const b1 = await balanceOf(demo01Id)
  ok('V4f 扣分 5→4', b1?.balance === 4, 'bal=' + b1?.balance)

  // V5 幂等重放：同 key → 302 + 不重复扣
  const d2 = await fetch(BASE + '/api/downloads/image/' + img1.id, {
    headers: { Authorization: 'Bearer ' + demoJwt, 'X-Idempotency-Key': idemKey }, redirect: 'manual',
  })
  const b2 = await balanceOf(demo01Id)
  ok('V5 幂等重放 302 且不重复扣', d2.status === 302 && b2?.balance === 4, 'status=' + d2.status + ' bal=' + b2?.balance)

  // V6 不足路径：demo02（余额 0）ZIP → 402；Package（若有 source）→ 402
  const demo02Pw = readSeedPassword('demo02@acmerd.com')
  const demo02Jwt = demo02Pw ? await login('demo02@acmerd.com', demo02Pw) : null
  const z = await fetch(BASE + '/api/downloads/zip', {
    method: 'POST', headers: { Authorization: 'Bearer ' + demo02Jwt, 'Content-Type': 'application/json', 'X-Idempotency-Key': randomUUID() },
    body: JSON.stringify({ assetLanguageId: langId, imageIds: [img1.id] }),
  })
  const zb = await z.json().catch(() => ({}))
  ok('V6a ZIP 余额不足 402', z.status === 402 && zb?.error?.code === 'insufficient_credits', 'status=' + z.status)
  if (srcs?.length) {
    const p = await fetch(BASE + '/api/downloads/package', {
      method: 'POST', headers: { Authorization: 'Bearer ' + demo02Jwt, 'Content-Type': 'application/json', 'X-Idempotency-Key': randomUUID() },
      body: JSON.stringify({ sourceId: srcs[0].id }),
    })
    ok('V6b Package 余额不足 402', p.status === 402, 'status=' + p.status)
  } else {
    console.log('  SKIP  V6b Package（生产无 enabled download_source）')
  }

  // V7 注册 gate（线上，e2e6 一次性 + finally 清理）
  const e2e6 = 'e2e6' + Date.now().toString(36) + '@pc7.test'
  const rg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e2e6, password: 'Pc7-' + randomUUID().replace(/-/g, '').slice(0, 8) + 'Aa1' }),
  })
  const rgb = await rg.json().catch(() => ({}))
  ok('V7a 线上注册 200（gate 开）', rg.status === 200 && rgb.ok === true, 'status=' + rg.status)
  e2e6Id = await userIdByEmail(e2e6)
  ok('V7b 用户已建（可登录态）', !!e2e6Id)

  // V10 seed 用户在位
  const all = await (await fetch(SB + '/auth/v1/admin/users?page=1&per_page=1000', { headers: svcH })).json()
  const emails = new Set((all.users || all || []).map((u) => (u.email || '').toLowerCase()))
  const seedsOk = [1, 2, 3, 4, 5, 6, 7, 8].every((i) => emails.has(`demo0${i}@acmerd.com`))
  ok('V10 demo01–08 全部在位', seedsOk)

  // V9 审计：本验证产生的 credits 调整有流水
  const audit = await (await fetch(SB + '/rest/v1/audit_logs?action=like.credits.*&order=created_at.desc&limit=5&select=action,created_at', { headers: svcH })).json()
  ok('V9 credits 审计新行', Array.isArray(audit) && audit.length > 0, 'latest=' + (audit?.[0]?.action ?? '—'))

  // 收尾：demo01 余额归零 + e2e6 清理
  const reset = await fetch(BASE + '/api/admin/users/' + demo01Id + '/credits', {
    method: 'POST', headers: { Authorization: 'Bearer ' + adminJwt, 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance: 0, reason: 'pc7-deploy-verify-reset' }),
  })
  const bEnd = await balanceOf(demo01Id)
  ok('CLEANUP demo01 余额归零', reset.status === 200 && bEnd?.balance === 0, 'bal=' + bEnd?.balance)
  if (e2e6Id) await fetch(SB + '/auth/v1/admin/users/' + e2e6Id, { method: 'DELETE', headers: svcH })
  const gone = await userIdByEmail(e2e6)
  ok('CLEANUP e2e6 零残留', !gone)
} catch (e) {
  console.error('FATAL', e instanceof Error ? e.message : e)
  fail++
}
console.log('\n===== PROD DEPLOY VERIFY: ' + pass + ' PASS / ' + fail + ' FAIL =====')
process.exit(fail === 0 ? 0 : 1)
