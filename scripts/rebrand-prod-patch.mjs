// 生产品牌重命名补丁：把 site_settings 的 brand_text / brand_title 改为 "AcmerdImage"
// 经 Worker admin API（与 V1.4 验证脚本同源：GoTrue 密码授权 + PATCH）。幂等。
// 凭据全部从 .env 读，绝不打印。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}

const SUPABASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const WORKER = 'https://image.acmerd.com'
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
const adminEmail = process.env.ADMIN_EMAIL
const adminPassword = process.env.ADMIN_PASSWORD
const TARGET = 'AcmerdImage'

if (!adminEmail || !adminPassword) {
  console.error('MISSING ADMIN_EMAIL / ADMIN_PASSWORD in .env')
  process.exit(1)
}

const loginRes = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
})
if (!loginRes.ok) {
  console.error('admin login FAILED', loginRes.status, await loginRes.text())
  process.exit(1)
}
const { access_token: jwt } = await loginRes.json()
console.log(`✅ admin login — token len ${jwt.length}`)

const authH = { apikey: anon, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
const svcH = { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' }

async function getSetting(key) {
  const r = await fetch(`${SUPABASE}/rest/v1/site_settings?key=eq.${encodeURIComponent(key)}&select=value`, { headers: { apikey: anon } })
  const rows = await r.json()
  return rows[0]?.value
}

const patchRes = await fetch(`${WORKER}/api/admin/settings`, {
  method: 'PATCH',
  headers: authH,
  body: JSON.stringify({ settings: { brand_text: TARGET, brand_title: TARGET } }),
})
const patchBody = await patchRes.json().catch(() => ({}))
console.log(`${patchRes.ok && patchBody.ok ? '✅' : '❌'} PATCH brand_text/brand_title → "${TARGET}" — HTTP ${patchRes.status} ${JSON.stringify(patchBody)}`)

const gotText = await getSetting('brand_text')
const gotTitle = await getSetting('brand_title')
console.log(`${gotText === TARGET ? '✅' : '❌'} anon read brand_text = ${JSON.stringify(gotText)}`)
console.log(`${gotTitle === TARGET ? '✅' : '❌'} anon read brand_title = ${JSON.stringify(gotTitle)}`)

const ok = patchRes.ok && patchBody.ok === true && gotText === TARGET && gotTitle === TARGET
console.log(`\n=== REBRAND PROD PATCH: ${ok ? 'PASS' : 'FAIL'} ===`)
process.exit(ok ? 0 : 1)
