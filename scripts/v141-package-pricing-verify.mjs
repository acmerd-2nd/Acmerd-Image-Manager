// ============================================================
// V1.4.1 Package 动态计价 — 生产价格矩阵验证（可复跑；幂等建实体 + finally 全量清理）
// 依据: docs/v1.4.1/01-design-gate.md（Owner D1–D4 + 附加矩阵测试要求）
//
// 矩阵（per-image cost = 0.5）:
//   单语言 EN 7 → 3.5 / 9 → 4.5 / 20 → 10 / 30 → 15
//   多语言 EN7 + DE8 + IT9 = 24 → 12
//   0 图 → not_available 404（绝不免费放行）
//   篡改 → 客户端多传 imageCount/cost 字段，金额仍 = 服务端权威 3.5
//   幂等 → 同 X-Idempotency-Key 重放：再次成功但 ledger 仅一条扣账
//
// 测试实体前缀: e2e7-（asset slug `e2e7-pkg-*`）；扣账用户 = 管理员账号，
//   结束后经 adjust_credits 还原快照余额（ledger 留痕可追溯，与 PC-7 先例一致）。
// 零凭据输出。Node fetch 默认不走代理（本机死代理环境安全）。
// ============================================================
import { readFileSync } from 'node:fs'

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const WORKER = 'https://image.acmerd.com'
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const adminEmail = process.env.ADMIN_EMAIL
const adminPassword = process.env.ADMIN_PASSWORD

if (!SUPABASE || !svcKey || !anon || !adminEmail || !adminPassword) {
  console.error('missing env'); process.exit(1)
}

const results = []
const rec = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const svc = { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' }

async function rest(method, table, qs, body) {
  const res = await fetch(`${SUPABASE}/rest/v1/${table}${qs ? '?' + qs : ''}`, {
    method, headers: svc, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

// ---------- admin 登录 ----------
const loginRes = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
})
if (!loginRes.ok) { console.error('admin login FAILED', loginRes.status); process.exit(1) }
const { access_token: jwt, user } = await loginRes.json()
const adminUid = user?.id
rec('admin login (GoTrue password grant)', true, `uid=${adminUid ? adminUid.slice(0, 8) + '…' : 'missing'}`)
const userH = { apikey: anon, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }

// ---------- 余额快照（用于结束还原） ----------
const balRes = await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance,unlimited`, { headers: svc })
const bal0 = Number((await balRes.json())[0]?.balance)
rec('balance snapshot', true, `balance=${bal0}`)

// 充值到测试额度（矩阵总消耗 ~53；结束后还原快照）
const TOPUP = 100
await fetch(`${SUPABASE}/rest/v1/rpc/adjust_credits`, {
  method: 'POST', headers: svc,
  body: JSON.stringify({ p_user_id: adminUid, p_balance: TOPUP, p_reason: 'v141 pricing verify topup' }),
})
rec('topup for matrix', true, `balance -> ${TOPUP}`)

// ---------- 预清理（上轮残留兜底） ----------
async function cleanupAssets() {
  await rest('DELETE', 'assets', 'slug=like.e2e7-pkg-*')
}
await cleanupAssets()

// ---------- 建测试资产矩阵 ----------
const PKG_URL = 'https://pan.quark.cn/s/e2e7-v141-test'
async function makeAsset(slug, langs) {
  // langs: [{ code, n }]；发布受 0003 PUBLISH_BLOCKED 守卫约束 →
  // 必须 draft 建资产/语言 → 插图 → 先发语言再发资产
  const a = await rest('POST', 'assets', '', { name: slug, slug, status: 'draft', description: 'V1.4.1 verify' })
  if (!a.ok) throw new Error(`asset ${slug}: ${a.status} ${await a.text()}`)
  const [row] = await (await fetch(`${SUPABASE}/rest/v1/assets?slug=eq.${slug}&select=id`, { headers: svc })).json()
  const assetId = row.id
  const source = await rest('POST', 'download_sources', '', { asset_id: assetId, provider: 'quark', url: PKG_URL, enabled: true })
  if (!source.ok) throw new Error(`source ${slug}: ${source.status} ${await source.text()}`)
  const [srcRow] = await (await fetch(`${SUPABASE}/rest/v1/download_sources?asset_id=eq.${assetId}&select=id`, { headers: svc })).json()
  for (const { code, n } of langs) {
    const l = await rest('POST', 'asset_languages', '', { asset_id: assetId, language_code: code, status: 'draft' })
    if (!l.ok) throw new Error(`lang ${slug}/${code}: ${l.status} ${await l.text()}`)
    const [lRow] = await (await fetch(`${SUPABASE}/rest/v1/asset_languages?asset_id=eq.${assetId}&language_code=eq.${code}&select=id`, { headers: svc })).json()
    if (n > 0) {
      const imgs = Array.from({ length: n }, (_, i) => ({
        asset_language_id: lRow.id, filename: `e2e7-${code}-${i}.jpg`, storage_path: `e2e7/unused/${code}-${i}`,
        status: 'ready', sort_order: i,
      }))
      const ins = await rest('POST', 'images', '', imgs)
      if (!ins.ok) throw new Error(`images ${slug}/${code}: ${ins.status} ${await ins.text()}`)
    }
    const lp = await rest('PATCH', 'asset_languages', `id=eq.${lRow.id}`, { status: 'published' })
    if (!lp.ok) throw new Error(`lang publish ${slug}/${code}: ${lp.status} ${await lp.text()}`)
  }
  if (langs.some((l) => l.n > 0)) {
    const ap = await rest('PATCH', 'assets', `id=eq.${assetId}`, { status: 'published' })
    if (!ap.ok) throw new Error(`asset publish ${slug}: ${ap.status} ${await ap.text()}`)
  }
  return { assetId, sourceId: srcRow.id }
}

// ---------- 计数源校验（与 Worker 同口径：基础表直查，service_role） ----------
// 注: published_assets 视图 grant 仅 anon/authenticated（0001），svc 查询 42501，
// 故脚本与 Worker 一致走 asset_languages + images 计数。
async function publishedImageCount(assetId) {
  const langIds = (await (await fetch(`${SUPABASE}/rest/v1/asset_languages?asset_id=eq.${assetId}&status=eq.published&select=id`, { headers: svc })).json()).map((r) => r.id)
  if (langIds.length === 0) return 0
  const res = await fetch(`${SUPABASE}/rest/v1/images?asset_language_id=in.(${langIds.join(',')})&status=eq.ready&select=id&limit=1`, {
    headers: { ...svc, Prefer: 'count=exact' },
  })
  const range = res.headers.get('content-range')
  if (range && range.includes('/')) return Number(range.split('/')[1])
  const all = await (await fetch(`${SUPABASE}/rest/v1/images?asset_language_id=in.(${langIds.join(',')})&status=eq.ready&select=id`, { headers: svc })).json()
  return Array.isArray(all) ? all.length : 0
}

const CASES = [
  { slug: 'e2e7-pkg-7', langs: [{ code: 'en', n: 7 }], expect: 3.5 },
  { slug: 'e2e7-pkg-9', langs: [{ code: 'en', n: 9 }], expect: 4.5 },
  { slug: 'e2e7-pkg-20', langs: [{ code: 'en', n: 20 }], expect: 10 },
  { slug: 'e2e7-pkg-30', langs: [{ code: 'en', n: 30 }], expect: 15 },
  { slug: 'e2e7-pkg-multi', langs: [{ code: 'en', n: 7 }, { code: 'de', n: 8 }, { code: 'it', n: 9 }], expect: 12 },
]

const built = []
try {
  for (const c of CASES) {
    built.push(await makeAsset(c.slug, c.langs))
    // 计数源校验：published 口径计数必须等于预期总数（跨语言合计）
    const total = c.langs.reduce((s, l) => s + l.n, 0)
    const viewCount = await publishedImageCount(built.at(-1).assetId)
    rec(`build ${c.slug} (count=${total})`, viewCount === total, `count=${viewCount}`)
  }

  // ---------- 矩阵：逐项调用 + 余额增量 + ledger 金额 ----------
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]
    const before = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
    const res = await fetch(`${WORKER}/api/downloads/package`, {
      method: 'POST', headers: { ...userH, 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ sourceId: built[i].sourceId }),
    })
    const body = await res.json().catch(() => null)
    const okCall = res.ok && body?.ok === true
    const after = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
    const delta = Math.round((before - after) * 100) / 100
    rec(`matrix ${c.slug}: ${c.langs.map(l => l.n).join('+') || 0} images → ${c.expect}`, okCall && delta === c.expect, `http=${res.status} delta=${delta}`)
    // ledger 金额核验（reference_id = sourceId）
    const [tx] = await (await fetch(`${SUPABASE}/rest/v1/credit_transactions?reference_id=eq.${built[i].sourceId}&select=amount,metadata&order=id.desc&limit=1`, { headers: svc })).json()
    rec(`ledger ${c.slug}`, Number(tx?.amount) === -c.expect && tx?.metadata?.image_count === c.langs.reduce((s, l) => s + l.n, 0), `amount=${tx?.amount}`)
  }

  // ---------- T6: 0 图 → not_available 404 ----------
  // 0003 PUBLISH_BLOCKED 结构性禁止"0 图发布"，故先发 1 图再删图，
  // 构造 published asset + image_count=0 → Worker 守卫必须拦截（纵深防御）
  built.push(await makeAsset('e2e7-pkg-zero', [{ code: 'en', n: 1 }]))
  const zeroCase = built.at(-1)
  const [zeroLang] = await (await fetch(`${SUPABASE}/rest/v1/asset_languages?asset_id=eq.${zeroCase.assetId}&select=id`, { headers: svc })).json()
  const delImgs = await rest('DELETE', 'images', `asset_language_id=eq.${zeroLang.id}`)
  if (!delImgs.ok) throw new Error(`zero images delete: ${delImgs.status}`)
  const paZero = await publishedImageCount(zeroCase.assetId)
  const balBeforeZero = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
  const zeroRes = await fetch(`${WORKER}/api/downloads/package`, {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ sourceId: zeroCase.sourceId }),
  })
  const zeroBody = await zeroRes.json().catch(() => null)
  const balAfterZero = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
  rec('zero-image → not_available 404 & no deduction',
    zeroRes.status === 404 && zeroBody?.error?.code === 'not_available' && balAfterZero === balBeforeZero,
    `count=${paZero} http=${zeroRes.status} code=${zeroBody?.error?.code}`)

  // ---------- 篡改：多传 imageCount/cost → 服务端权威金额不变 ----------
  const balBeforeTamper = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
  const tamperRes = await fetch(`${WORKER}/api/downloads/package`, {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ sourceId: built[0].sourceId, imageCount: 999, cost: 0.01, amount: 0.01, credits: 0 }),
  })
  const tamperBody = await tamperRes.json().catch(() => null)
  const balAfterTamper = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
  const tamperDelta = Math.round((balBeforeTamper - balAfterTamper) * 100) / 100
  rec('tamper (extra imageCount/cost fields) → still 3.5',
    tamperRes.ok && tamperBody?.ok === true && tamperDelta === 3.5, `delta=${tamperDelta}`)

  // ---------- 幂等：同 key 重放 → 再成功但 ledger 仅一条 ----------
  const idemKey = crypto.randomUUID()
  const idem1 = await fetch(`${WORKER}/api/downloads/package`, {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': idemKey }, body: JSON.stringify({ sourceId: built[1].sourceId }),
  })
  const idem2 = await fetch(`${WORKER}/api/downloads/package`, {
    method: 'POST', headers: { ...userH, 'X-Idempotency-Key': idemKey }, body: JSON.stringify({ sourceId: built[1].sourceId }),
  })
  const cntRes = await fetch(`${SUPABASE}/rest/v1/credit_transactions?idempotency_key=eq.${idemKey}&select=id`, { headers: svc })
  const cntRows = await cntRes.json()
  rec('idempotency replay: both 200, single ledger row', idem1.ok && idem2.ok && cntRows.length === 1, `ledgerRows=${cntRows.length}`)
} finally {
  // ---------- finally 清理 ----------
  await cleanupAssets()
  const leftover = await (await fetch(`${SUPABASE}/rest/v1/assets?slug=like.e2e7-pkg-*&select=id`, { headers: svc })).json()
  rec('cleanup: e2e7 assets removed', leftover.length === 0, `leftover=${leftover.length}`)
  // 余额还原（adjust_credits = set balance 语义；service_role 可执行）
  await fetch(`${SUPABASE}/rest/v1/rpc/adjust_credits`, {
    method: 'POST', headers: svc,
    body: JSON.stringify({ p_user_id: adminUid, p_balance: bal0, p_reason: 'v141 pricing verify restore' }),
  })
  const balFinal = Number((await (await fetch(`${SUPABASE}/rest/v1/credit_accounts?user_id=eq.${adminUid}&select=balance`, { headers: svc })).json())[0].balance)
  rec('balance restored to snapshot', balFinal === bal0, `${balFinal} === ${bal0}`)
}

const pass = results.filter(Boolean).length
console.log(`\n=== V1.4.1 PACKAGE PRICING VERIFY: ${pass}/${results.length} PASS ===`)
process.exit(pass === results.length ? 0 : 1)
