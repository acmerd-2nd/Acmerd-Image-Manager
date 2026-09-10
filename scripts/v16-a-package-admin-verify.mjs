// V1.6.0-A：后台「网盘链接」写入链路的生产集成验证（admin 用户 JWT 经 PostgREST，与 supabase-js 同 RLS 面）
// 只验证本阶段唯一新增的生产行为：admin 在 download_sources 上 CRUD + 0004 URL 守卫终审 + download_source.updated 审计。
// 隔离资产（draft，e2e-a 前缀），finally 删资产（级联清 download_sources）并核零残留。
import { readFileSync } from 'node:fs'
for (const f of ['.env', '.dev.vars']) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const U = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const R = `${U}/rest/v1`

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!login.ok) { console.error('admin login failed', login.status); process.exit(1) }
const jwt = (await login.json()).access_token
const H = (extra = {}) => ({ apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...extra })
const rest = async (path, method = 'GET', body, extra = {}) => {
  const res = await fetch(`${R}/${path}`, { method, headers: H(extra), body: body === undefined ? undefined : JSON.stringify(body) })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, json, message: json?.message }
}
const auditCount = async () => (await (await fetch(`${R}/audit_logs?action=eq.download_source.updated&select=id`, { headers: H() })).json()).length

const assetId = crypto.randomUUID()
const slug = `e2e-a-${assetId.slice(0, 8)}`
const list = async () => (await rest(`download_sources?asset_id=eq.${assetId}&select=id,provider,url,enabled&order=provider.asc`)).json ?? []

try {
  // 0) 隔离 draft 资产
  let r = await rest('assets', 'POST', { id: assetId, name: 'e2e-a 网盘验证', slug, status: 'draft' }, { Prefer: 'return=representation' })
  ok('A0 建隔离 draft 资产', r.status < 300, `${r.status} ${r.message ?? ''}`)

  const base = await auditCount()

  // 1) 合法 upsert（quark）
  r = await rest('download_sources?on_conflict=asset_id,provider', 'POST',
    { asset_id: assetId, provider: 'quark', url: 'https://pan.quark.cn/s/e2etestaaa', enabled: true },
    { Prefer: 'resolution=merge-duplicates,return=representation' })
  ok('A1 合法 quark 链接写入 2xx', r.status < 300 && Array.isArray(r.json) && r.json.length === 1, `${r.status} ${r.message ?? ''}`)
  let rows = await list()
  ok('A1b admin 侧可读到该 quark 行', rows.length === 1 && rows[0].provider === 'quark' && rows[0].url === 'https://pan.quark.cn/s/e2etestaaa')

  // 2) 审计写 download_source.updated
  let audited = (await auditCount()) - base
  ok('A2 写入产生 download_source.updated 审计', audited >= 1, `delta=${audited}`)

  // 3) upsert 同 provider 改 URL = 更新（唯一键不新增行）
  r = await rest('download_sources?on_conflict=asset_id,provider', 'POST',
    { asset_id: assetId, provider: 'quark', url: 'https://pan.quark.cn/s/e2etestbbb', enabled: true },
    { Prefer: 'resolution=merge-duplicates,return=representation' })
  rows = await list()
  ok('A3 同 provider 再写为更新（仍 1 行、URL 已变）', rows.length === 1 && rows[0].url === 'https://pan.quark.cn/s/e2etestbbb', `rows=${rows.length}`)
  audited = (await auditCount()) - base
  ok('A3b 更新同样写审计（delta≥2）', audited >= 2, `delta=${audited}`)

  // 4) 0004 守卫终审拒绝：http / 非白名单域 / 带端口 / 带凭据
  const bad = [
    ['非 https', 'http://pan.quark.cn/s/x'],
    ['域不在白名单', 'https://evil.example.com/s/x'],
    ['带端口', 'https://pan.quark.cn:8080/s/x'],
    ['带 userinfo', 'https://u@pan.quark.cn/s/x'],
  ]
  for (const [label, url] of bad) {
    const rb = await rest('download_sources?on_conflict=asset_id,provider', 'POST',
      { asset_id: assetId, provider: 'baidu', url, enabled: true },
      { Prefer: 'resolution=merge-duplicates,return=representation' })
    ok(`A4 拒绝非法链接（${label}）`, rb.status >= 400 && /DOWNLOAD_URL_INVALID/.test(rb.message ?? ''), `${rb.status} ${rb.message ?? ''}`)
  }
  rows = await list()
  ok('A4b 非法链接均未落库（仍只 1 行 quark）', rows.length === 1 && rows.every((x) => x.provider === 'quark'), `rows=${JSON.stringify(rows.map((x) => x.provider))}`)

  // 5) 合法百度（yun.baidu.com）写入 + enabled 关闭仍可 admin 读，但前台 RLS select 会过滤 enabled=false
  r = await rest('download_sources?on_conflict=asset_id,provider', 'POST',
    { asset_id: assetId, provider: 'baidu', url: 'https://yun.baidu.com/s/e2etestb', enabled: false },
    { Prefer: 'resolution=merge-duplicates,return=representation' })
  ok('A5 合法 yun.baidu.com（enabled=false）写入 2xx', r.status < 300, `${r.status} ${r.message ?? ''}`)
  rows = await list()
  ok('A5b admin 读到停用行', rows.length === 2 && rows.find((x) => x.provider === 'baidu')?.enabled === false, `rows=${rows.length}`)

  // 6) 删除 quark 行
  const quarkId = rows.find((x) => x.provider === 'quark').id
  r = await rest(`download_sources?id=eq.${quarkId}`, 'DELETE')
  ok('A6 删除行 2xx', r.status < 300, `${r.status}`)
  rows = await list()
  ok('A6b 删除后仅剩停用 baidu 行', rows.length === 1 && rows[0].provider === 'baidu')

  // 收尾审计总增量（ins/update/delete 全写同一动作）
  ok('A6c 全程写审计累计 ≥4（含删除）', (await auditCount()) - base >= 4, `delta=${(await auditCount()) - base}`)
} finally {
  // 删资产 → 级联清 download_sources；核对零残留
  await rest(`assets?id=eq.${assetId}`, 'DELETE')
  const leftover = await rest(`download_sources?asset_id=eq.${assetId}&select=id`).then((x) => x.json ?? [])
  const assetGone = (await rest(`assets?id=eq.${assetId}&select=id`).then((x) => x.json ?? [])).length === 0
  ok('Z1 夹具资产已删除', assetGone)
  ok('Z2 download_sources 级联清零', leftover.length === 0, `leftover=${leftover.length}`)
  console.log(`\n${pass} PASS / ${fail} FAIL`)
}
process.exit(fail > 0 ? 1 : 0)
