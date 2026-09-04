#!/usr/bin/env node
// Phase 10 · R2 Auth + R5 Download + R1 抽样（L-C 生产在线 E2E）
// 执行方式：set -a && . ./.env && set +a && node scripts/phase10-online-e2e.mjs
// 红线：一次性实体 e2e10.lc.* 前缀；临时资产/图/源全部 finally 清理 + 反向查询 0 残留；
//       不触碰既有真实行；不回显 secret/token/密码。
const BASE = process.env.WORKER_BASE || 'https://image.acmerd.com'
const SB = process.env.SUPABASE_URL.replace(/\/$/, '')
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const PREFIX = 'e2e10.lc.'
const ASSET_PREFIX = `e2e10-lc-${Date.now().toString(36)}`

if (!SB || !SVC || !PUB || !ADMIN_EMAIL || !ADMIN_PASSWORD) { console.error('FATAL: missing env'); process.exit(2) }
let pass = 0, fail = 0
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`) } else { fail++; console.log(`  FAIL  ${n}${d ? ' :: ' + d : ''}`) } }
async function jfetch(url, init = {}, timeoutMs = 30000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'manual', ...init, signal: ctl.signal })
    const txt = await res.text(); let body = null
    try { body = txt ? JSON.parse(txt) : null } catch { body = txt }
    return { status: res.status, body, raw: txt, headers: res.headers }
  } finally { clearTimeout(t) }
}
const rand = () => Math.random().toString(36).slice(2, 10)
const adminDomain = ADMIN_EMAIL.includes('@') ? ADMIN_EMAIL.split('@')[1] : 'example.com'
const jsonHeaders = (token) => ({ 'content-type': 'application/json', apikey: PUB, Authorization: `Bearer ${token ?? ''}` })
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }
// 1x1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const tempUsers = [] // {id}
let tempAssetId = null, tempStoragePaths = []

async function mkUser(tag) {
  const email = `${PREFIX}${tag}.${rand()}@${adminDomain}`
  const password = `P10lc_${rand()}${rand()}`
  const r = await jfetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: svcH, body: JSON.stringify({ email, password, email_confirm: true }) })
  if (r.status !== 200) throw new Error(`${tag} create failed: ${r.raw?.slice(0, 150)}`)
  tempUsers.push(r.body.id)
  const l = await jfetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email, password }) })
  if (l.status !== 200) throw new Error(`${tag} login failed`)
  return { id: r.body.id, email, password, jwt: l.body.access_token }
}
async function cleanup() {
  console.log('\n--- cleanup（零残留断言）---')
  // 临时资产（DB 级联）+ Storage 对象
  if (tempAssetId) {
    const d = await jfetch(`${SB}/rest/v1/assets?id=eq.${tempAssetId}`, { method: 'DELETE', headers: svcH })
    ok(`LC-Z1 删除临时资产 → ${d.status}`, d.status >= 200 && d.status < 300 || d.status === 404)
  }
  for (const p of tempStoragePaths) {
    const d = await jfetch(`${SB}/storage/v1/object/images/${p}`, { method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    ok(`LC-Z2 删除 Storage 对象 ${p.slice(-24)} → ${d.status}`, [200, 204, 404].includes(d.status))
  }
  for (const id of tempUsers) {
    const d = await jfetch(`${SB}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    ok(`LC-Z3 删除一次性用户 ${id.slice(0, 8)}… → ${d.status}`, [200, 204].includes(d.status))
  }
  // 反向查询 0 残留（D1 附加约束）。注意：profiles 无 email 列（email 在 auth.users），按 user_id 反查。
  const q = async (url) => { const r = await jfetch(url, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } }); return Array.isArray(r.body) ? r.body.length : -1 }
  ok('LC-Z4 反向查询 assets slug 前缀残留 = 0', (await q(`${SB}/rest/v1/assets?slug=like.${encodeURIComponent(ASSET_PREFIX + '*')}&select=id`)) === 0)
  const idList = tempUsers.join(',') // PostgREST in.() 裸 UUID
  ok('LC-Z5 反向查询 profiles（按本次 user ids）残留 = 0', tempUsers.length > 0 ? (await q(`${SB}/rest/v1/profiles?id=in.(${idList})&select=id`)) === 0 : true)
  const au = await jfetch(`${SB}/auth/v1/admin/users?per_page=200&query=${encodeURIComponent(PREFIX)}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  ok('LC-Z6 反向查询 auth.users 前缀残留 = 0', (au.body?.users ?? []).filter(u => (u.email || '').startsWith(PREFIX)).length === 0)
  const imgs = await jfetch(`${SB}/rest/v1/images?filename=like.${encodeURIComponent('e2e10-*')}&select=id`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  ok('LC-Z7 反向查询 images e2e10 文件名残留 = 0', Array.isArray(imgs.body) && imgs.body.length === 0)
}

try {
  console.log('=== Phase 10 · L-C 生产在线 E2E（R2 Auth / R5 Download / R1 抽样）===')
  const svc = { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } }

  // ---------- R2 Auth Regression ----------
  console.log('\n--- R2 Auth（真实 signup/login/session/logout）---')
  const rEmail = `${PREFIX}r2self.${rand()}@${adminDomain}`
  const rPass = `P10lc_${rand()}${rand()}`
  const reg = await jfetch(`${SB}/auth/v1/signup`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: rEmail, password: rPass }) })
  ok('R2-1 Register（auth/v1/signup，邮箱验证关闭直返 session）→ 200', reg.status === 200 && !!reg.body?.access_token, reg.raw?.slice(0, 120))
  if (reg.body?.user?.id) tempUsers.push(reg.body.user.id) // 注意：signup 返回结构是 {access_token, user:{id}}
  const u = reg.body?.access_token ? { jwt: reg.body.access_token, refresh: reg.body.refresh_token } : null
  let ref = await jfetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ refresh_token: u?.refresh }) })
  ok('R2-2 Session 刷新（refresh_token grant）→ 200 新 access_token', ref.status === 200 && !!ref.body?.access_token)
  const lo = await jfetch(`${SB}/auth/v1/logout?scope=global`, { method: 'POST', headers: jsonHeaders(ref.body?.access_token ?? u?.jwt) })
  ok(`R2-3 Logout → ${lo.status}`, [204, 200].includes(lo.status))
  const ref2 = await jfetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ refresh_token: u?.refresh }) })
  ok(`R2-4 Logout 后旧 refresh_token 已吊销 → ${ref2.status}（期望 400）`, ref2.status === 400, ref2.raw?.slice(0, 100))
  const relogin = await jfetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: rEmail, password: rPass }) })
  ok('R2-5 Login（logout 后重新密码登录）→ 200', relogin.status === 200)

  // ---------- R5 Download（一次性 user 身份，先取生产真实 published 资产） ----------
  console.log('\n--- R5 Download（真实链路）---')
  const user1 = await mkUser('dl')
  const pub = await jfetch(`${SB}/rest/v1/published_assets?select=id,slug&limit=1`, { headers: jsonHeaders(user1.jwt) })
  const realAsset = Array.isArray(pub.body) ? pub.body[0] : null
  ok('R5-0 user 读取 published_assets → 1 行', !!realAsset, JSON.stringify(realAsset))
  const lang = await jfetch(`${SB}/rest/v1/asset_languages?select=id&asset_id=eq.${realAsset.id}&status=eq.published&limit=1`, { headers: jsonHeaders(user1.jwt) })
  const langId = Array.isArray(lang.body) ? lang.body[0]?.id : null
  const imgs = await jfetch(`${SB}/rest/v1/images?select=id,storage_path&asset_language_id=eq.${langId}&order=sort_order.asc`, { headers: jsonHeaders(user1.jwt) })
  const img1 = Array.isArray(imgs.body) ? imgs.body[0] : null
  ok('R5-0b user 读取 published 语言与图 → 各 1', !!langId && !!img1)

  const single = await jfetch(`${BASE}/api/downloads/image/${img1.id}`, { headers: jsonHeaders(user1.jwt) })
  ok(`R5-1 Single：/api/downloads/image/:id → 302（软门控）`, single.status === 302, `status=${single.status}`)
  const loc = single.headers.get('location') || ''
  const real = loc ? await jfetch(loc) : null
  ok(`R5-1b 302 跟随 → Storage 对象 200，字节 > 0（${real?.body?.length ?? 0}B，host=${loc ? new URL(loc).host : 'N/A'}）`, real?.status === 200 && (real.body?.length ?? 0) > 0)

  const zip = await jfetch(`${BASE}/api/downloads/zip`, { method: 'POST', headers: { ...jsonHeaders(user1.jwt), 'content-type': 'application/json' }, body: JSON.stringify({ assetLanguageId: langId, imageIds: [img1.id] }) })
  const zipBuf = typeof zip.body === 'string' ? Buffer.from(zip.raw, 'binary') : null
  const isZip = zipBuf && zipBuf.length > 1000 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b
  ok(`R5-2 ZIP：单图打包 → 200 PK 头字节=${zipBuf?.length ?? 0}B`, zip.status === 200 && !!isZip, `status=${zip.status} ct=${zip.headers.get('content-type')}`)
  const dispo = zip.headers.get('content-disposition') || ''
  ok('R5-2b ZIP Content-Disposition 生效（Worker 直出 200）', dispo.includes('.zip'), dispo.slice(0, 80))
  const zipBad = await jfetch(`${BASE}/api/downloads/zip`, { method: 'POST', headers: { ...jsonHeaders(user1.jwt), 'content-type': 'application/json' }, body: JSON.stringify({ assetLanguageId: langId, imageIds: [] }) })
  ok(`R5-2c ZIP 空选择 → 拒绝（${zipBad.status}）`, zipBad.status === 400)

  const noneSrc = await jfetch(`${SB}/rest/v1/download_sources?select=id&asset_id=eq.${realAsset.id}`, { headers: jsonHeaders(user1.jwt) })
  ok(`R5-3 None 语义：真实资产 download_sources = ${Array.isArray(noneSrc.body) ? noneSrc.body.length : '?'}（0 → 面板无链接态）`, Array.isArray(noneSrc.body) && noneSrc.body.length === 0)

  // ---------- 临时资产（admin 建，全链路 R5 Both/1-direct/Multi + R1 admin 正向） ----------
  console.log('\n--- 临时资产与 Admin 正向操作 ---')
  const adminLogin = await jfetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) })
  ok('R1-0 admin 登录 → 200', adminLogin.status === 200)
  const adminJwt = adminLogin.body.access_token

  const slug = `${ASSET_PREFIX}-a0`
  const ar = await jfetch(`${SB}/rest/v1/assets`, { method: 'POST', headers: { ...svcH, Prefer: 'return=representation' }, body: JSON.stringify({ name: 'E2E10 Temp Asset', slug, status: 'draft' }) })
  ok(`R1-1 admin 经 service 通道建临时资产 → ${ar.status}`, ar.status === 201 && !!ar.body?.[0]?.id, ar.raw?.slice(0, 120))
  tempAssetId = ar.body?.[0]?.id
  const langR = await jfetch(`${SB}/rest/v1/asset_languages`, { method: 'POST', headers: { ...svcH, Prefer: 'return=representation' }, body: JSON.stringify({ asset_id: tempAssetId, language_code: 'en', status: 'published' }) })
  const tLangId = langR.body?.[0]?.id
  // 上传 2 张真图到 Storage（admin）+ DB 行
  const imgIds = []
  for (let i = 1; i <= 2; i++) {
    const path = `${tempAssetId}/en/e2e10-${i}.png`
    const up = await jfetch(`${SB}/storage/v1/object/images/${path}`, { method: 'POST', headers: { apikey: PUB, Authorization: `Bearer ${adminJwt}`, 'content-type': 'image/png' }, body: PNG })
    ok(`R1-2 admin Storage 上传 ${path.slice(-16)} → ${up.status}`, [200, 201].includes(up.status))
    tempStoragePaths.push(path)
    const ir = await jfetch(`${SB}/rest/v1/images`, { method: 'POST', headers: { ...svcH, Prefer: 'return=representation' }, body: JSON.stringify({ asset_language_id: tLangId, filename: `e2e10-${i}.png`, storage_path: `images/${path}`, sort_order: i, file_size: PNG.length, mime_type: 'image/png', width: 1, height: 1 }) })
    ok(`R1-3 admin 建 image 行 ${i} → ${ir.status}`, ir.status === 201 && !!ir.body?.[0]?.id, ir.raw?.slice(0, 100))
    imgIds.push(ir.body?.[0]?.id)
  }
  const pubR = await jfetch(`${SB}/rest/v1/assets?id=eq.${tempAssetId}`, { method: 'PATCH', headers: svcH, body: JSON.stringify({ status: 'published', cover_image_id: imgIds[0] }) })
  ok(`R1-4 发布临时资产（带封面）→ ${pubR.status}`, pubR.status >= 200 && pubR.status < 300, pubR.raw?.slice(0, 100))

  // R5-4 Both 语义：quark + baidu 双源（admin 建，0004 守卫校验 https+host）
  const src = async (provider, url) => jfetch(`${SB}/rest/v1/download_sources`, { method: 'POST', headers: { ...svcH, Prefer: 'return=representation' }, body: JSON.stringify({ asset_id: tempAssetId, provider, url }) })
  const badHost = await src('quark', 'https://evil.example.com/pan/xxx')
  ok(`R5-4 0004 守卫：非白名单 host → 拒绝（${badHost.status}）`, badHost.status >= 400)
  const s1 = await src('quark', 'https://pan.quark.cn/s/e2e10test')
  const s2 = await src('baidu', 'https://pan.baidu.com/s/e2e10test')
  ok(`R5-5 Both 语义：quark+baidu 白名单双源建立 → ${s1.status}/${s2.status}`, s1.status === 201 && s2.status === 201)
  const cnt2 = await jfetch(`${SB}/rest/v1/download_sources?select=id&asset_id=eq.${tempAssetId}`, { headers: jsonHeaders(user1.jwt) })
  ok('R5-6 user 可读临时资产双源（2 → UI 选择器语义数据成立）', Array.isArray(cnt2.body) && cnt2.body.length === 2)
  const del1 = await jfetch(`${SB}/rest/v1/download_sources?id=eq.${s2.body?.[0]?.id}`, { method: 'DELETE', headers: svcH })
  const cnt3 = await jfetch(`${SB}/rest/v1/download_sources?select=id&asset_id=eq.${tempAssetId}`, { headers: jsonHeaders(user1.jwt) })
  ok(`R5-7 1-direct 语义：删 baidu 源后剩 1（${del1.status}，count=${Array.isArray(cnt3.body) ? cnt3.body.length : '?'}）`, del1.status >= 200 && del1.status < 300 && Array.isArray(cnt3.body) && cnt3.body.length === 1)

  // R5-8 Multi ZIP（临时资产 2 图）
  const zip2 = await jfetch(`${BASE}/api/downloads/zip`, { method: 'POST', headers: { ...jsonHeaders(user1.jwt), 'content-type': 'application/json' }, body: JSON.stringify({ assetLanguageId: tLangId, imageIds: imgIds }) })
  const zip2Buf = typeof zip2.body === 'string' ? Buffer.from(zip2.raw, 'binary') : null
  ok(`R5-8 Multi：2 图 ZIP → 200 PK 头 ${zip2Buf?.length ?? 0}B（1×1 微图合法体积可仅数百字节）`, zip2.status === 200 && zip2Buf && zip2Buf.length > 100 && zip2Buf[0] === 0x50 && zip2Buf[1] === 0x4b, `status=${zip2.status}`)

  // R1 admin 正向变更链（Worker 通道）
  const users = await jfetch(`${BASE}/api/admin/users?page=1&per_page=50`, { headers: jsonHeaders(adminJwt) })
  ok('R1-5 admin GET /api/admin/users → 200 envelope', users.status === 200 && Array.isArray(users.body?.users))
  const stats = await jfetch(`${BASE}/api/admin/stats`, { headers: jsonHeaders(adminJwt) })
  ok('R1-6 admin GET /api/admin/stats → 200', stats.status === 200)
  const promo = await jfetch(`${BASE}/api/admin/users/${user1.id}/role`, { method: 'POST', headers: jsonHeaders(adminJwt), body: JSON.stringify({ role: 'admin' }) })
  ok(`R1-7 admin 提权一次性用户 → ${promo.status}`, promo.status >= 200 && promo.status < 300, promo.raw?.slice(0, 100))
  const chk = await jfetch(`${SB}/rest/v1/user_roles?select=role&user_id=eq.${user1.id}`, { headers: svcH })
  ok('R1-8 提权落库 role=admin', Array.isArray(chk.body) && chk.body[0]?.role === 'admin')
  const demote = await jfetch(`${BASE}/api/admin/users/${user1.id}/role`, { method: 'POST', headers: jsonHeaders(adminJwt), body: JSON.stringify({ role: 'user' }) })
  const chk2 = await jfetch(`${SB}/rest/v1/user_roles?select=role&user_id=eq.${user1.id}`, { headers: svcH })
  ok(`R1-9 降回 user → ${demote.status}，落库 role=user`, demote.status >= 200 && demote.status < 300 && Array.isArray(chk2.body) && chk2.body[0]?.role === 'user')
  // R1-10 USER 不能进 Admin（guard 前端路由 + Worker 403 已在 R6-3 证；此处证 Worker 维度已足够）

  // audit 留痕抽验（本会话产生的 user.role_changed）
  const aud = await jfetch(`${SB}/rest/v1/audit_logs?select=action&order=created_at.desc&limit=10`, { headers: jsonHeaders(adminJwt) })
  const acts = Array.isArray(aud.body) ? aud.body.map(x => x.action) : []
  ok('R1-10 审计抽验：user.role_changed 已落 allowlist 审计', acts.includes('user.role_changed'), acts.slice(0, 5).join(','))
} catch (e) {
  fail++; console.error('[abort]', e.message)
} finally {
  await cleanup()
  console.log(`\n=== L-C 结果: PASS=${pass} FAIL=${fail} ===`)
  process.exit(fail > 0 ? 1 : 0)
}
