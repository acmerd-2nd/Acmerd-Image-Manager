// 临时脚本：V1.4 生产功能验证（admin 登录 → PATCH 品牌 → 上传 logo → 删 logo → 审计）
// 修正：Worker API 基址必须是 image.acmerd.com（非 SUPABASE_URL）。
// 严格幂等：结束前把 brand_text/brand_title 还原为种子值，logo 还原为移除态（生产默认）。
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
const WORKER = 'https://image.acmerd.com' // ← Worker 基址（不是 SUPABASE_URL）
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
const adminEmail = process.env.ADMIN_EMAIL
const adminPassword = process.env.ADMIN_PASSWORD
const ghToken = process.env.GITHUB_TOKEN

const results = []
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 1) admin 登录（GoTrue password grant，基址是 SUPABASE）
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
rec('admin login (GoTrue password grant)', true, `token len ${jwt.length}`)

const authH = { apikey: anon, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
const anonH = { apikey: anon }
const svcH = { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' }

async function getSetting(key) {
  const r = await fetch(`${SUPABASE}/rest/v1/site_settings?key=eq.${encodeURIComponent(key)}&select=value`, { headers: anonH })
  const rows = await r.json()
  return rows[0]?.value
}

// 2) PATCH brand_text / brand_title
const TEST_TEXT = 'V1.4TEST探知'
const patchRes = await fetch(`${WORKER}/api/admin/settings`, {
  method: 'PATCH',
  headers: authH,
  body: JSON.stringify({ settings: { brand_text: TEST_TEXT, brand_title: TEST_TEXT } }),
})
const patchBody = await patchRes.json().catch(() => ({}))
rec('PATCH /api/admin/settings brand_text+brand_title', patchRes.ok && patchBody.ok === true,
  `HTTP ${patchRes.status} ${JSON.stringify(patchBody)}`)

// 3) 公开读验证（anon 直读 site_settings，经 SUPABASE REST）
const readBack = await getSetting('brand_text')
rec('anon read reflects PATCH (brand_text)', readBack === TEST_TEXT, `got=${JSON.stringify(readBack)}`)
const readBackTitle = await getSetting('brand_title')
rec('anon read reflects PATCH (brand_title)', readBackTitle === TEST_TEXT, `got=${JSON.stringify(readBackTitle)}`)

// 4) 还原 brand_text/brand_title 为种子值
await fetch(`${WORKER}/api/admin/settings`, {
  method: 'PATCH',
  headers: authH,
  body: JSON.stringify({ settings: { brand_text: 'ACMERD · 探知', brand_title: 'ACMERD · 探知' } }),
})
const reverted = await getSetting('brand_text')
rec('revert brand_text to seed', reverted === 'ACMERD · 探知', `got=${JSON.stringify(reverted)}`)

// 5) 上传 logo（1x1 PNG）
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const pngBytes = Buffer.from(pngB64, 'base64')
const fd = new FormData()
fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'logo.png')
const upRes = await fetch(`${WORKER}/api/admin/branding/logo`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
  body: fd,
})
const upBody = await upRes.json().catch(() => ({}))
rec('POST /api/admin/branding/logo (1x1 PNG)', upRes.ok && upBody.ok === true,
  `HTTP ${upRes.status} ${JSON.stringify(upBody)}`)
const logoPath = upBody.path
const logoSetting = logoPath ? await getSetting('brand_logo_path') : null
rec('brand_logo_path set after upload', logoPath ? logoSetting === logoPath : false,
  `setting=${JSON.stringify(logoSetting)} path=${logoPath}`)

// 6) 验证 GitHub 仓出现 branding/logo.png
if (ghToken && logoPath) {
  try {
    const ghRes = await fetch(`https://api.github.com/repos/acmerd-2nd/-Photo-Acmerd-Image-Manager/contents/${logoPath}`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' },
    })
    rec('GitHub repo contains branding/logo.png', ghRes.ok, `HTTP ${ghRes.status}`)
  } catch (e) {
    rec('GitHub repo contains branding/logo.png', false, `network err (local egress may block): ${e.message}`)
  }
}

// 7) 删除 logo
const delRes = await fetch(`${WORKER}/api/admin/branding/logo`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${jwt}` },
})
const delBody = await delRes.json().catch(() => ({}))
rec('DELETE /api/admin/branding/logo', delRes.ok && delBody.ok === true,
  `HTTP ${delRes.status} ${JSON.stringify(delBody)}`)
const logoAfterDel = await getSetting('brand_logo_path')
rec('brand_logo_path cleared after DELETE', logoAfterDel === '', `got=${JSON.stringify(logoAfterDel)}`)

// 8) 审计日志（service_role 直读）
const audRes = await fetch(`${SUPABASE}/rest/v1/audit_logs?action=eq.settings.updated&select=action,created_at,metadata&order=created_at.desc&limit=5`, { headers: svcH })
if (audRes.ok) {
  const aud = await audRes.json()
  const recent = aud[0]
  rec('audit_logs settings.updated present', aud.length > 0,
    `recent=${recent ? JSON.stringify({ action: recent.action, metadata: recent.metadata }) : 'none'}`)
} else {
  rec('audit_logs settings.updated present', false, `HTTP ${audRes.status}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== V1.4 PROD VERIFY: ${results.length - failed.length}/${results.length} PASS ===`)
process.exit(failed.length === 0 ? 0 : 1)
