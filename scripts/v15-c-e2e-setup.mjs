// V1.5 Phase C 前台实走夹具：造一个「已发布 + 双语言 + 启用 360° 序列」的 e2e 资产
// 目的：验证 published_360 → Spin360 的真实前台链路（含语言解耦），全部走生产 Worker 端点与真实图片仓。
// 用法：node scripts/v15-c-e2e-setup.mjs   （状态写入 .scratch/c-e2e-state.json 供 teardown 使用）
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

for (const f of ['.env', '.dev.vars']) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const SITE = process.env.WORKER_BASE ?? 'http://127.0.0.1:8787'
const U = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const FRAMES_DIR = '.scratch/360-frames'

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!login.ok) { console.error('admin login failed', login.status); process.exit(1) }
const jwt = (await login.json()).access_token
const authH = () => ({ Authorization: `Bearer ${jwt}` })

const assetId = crypto.randomUUID()
const slug = 'e2e-c-360'
const langIds = {}
const imageIds = []
let sequenceId = null

const rest = async (path, method = 'GET', body, repr = false) => {
  const headers = repr ? { ...svcH, Prefer: 'return=representation' } : svcH
  const res = await fetch(`${U}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) }
}
const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${SITE}${path}`, {
    method,
    headers: body instanceof FormData ? authH() : { ...authH(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

try {
  // 1) 资产（draft）
  let r = await rest('assets', 'POST', { id: assetId, name: 'e2e-c 360前台走查', slug, status: 'draft' })
  if (r.status >= 300) throw new Error(`asset insert ${r.status} ${JSON.stringify(r.json)}`)

  // 2) 两个语言 + 各一张真实图片（经 Worker 上传 → 真实 GitHub 对象 + ready 行）
  for (const code of ['en', 'de']) {
    const lr = await rest('asset_languages', 'POST', { asset_id: assetId, language_code: code, status: 'draft' }, true)
    if (lr.status >= 300) throw new Error(`lang insert ${lr.status} ${JSON.stringify(lr.json)}`)
    langIds[code] = (lr.json ?? [])[0].id
    const form = new FormData()
    form.append('file', new Blob([readFileSync(join(FRAMES_DIR, '0001.png'))], { type: 'image/png' }), `e2e-c-${code}.png`)
    form.append('asset_language_id', langIds[code])
    const up = await api('/api/admin/images/github-upload', 'POST', form)
    if (up.status !== 200 || !up.json?.image_id) throw new Error(`image upload ${up.status} ${JSON.stringify(up.json)}`)
    imageIds.push(up.json.image_id)
  }

  // 3) 发布（守卫触发器终审：需 published 语言 + ready 图片）
  for (const code of ['en', 'de']) {
    const p = await rest(`asset_languages?id=eq.${langIds[code]}`, 'PATCH', { status: 'published' })
    if (p.status >= 300) throw new Error(`lang publish ${p.status} ${JSON.stringify(p.json)}`)
  }
  const ap = await rest(`assets?id=eq.${assetId}`, 'PATCH', { status: 'published' })
  if (ap.status >= 300) throw new Error(`asset publish ${ap.status} ${JSON.stringify(ap.json)}`)

  // 4) 360 序列：创建 → 分批传帧（含进度）→ complete → activate
  r = await api(`/api/admin/assets/${assetId}/360-sequences`, 'POST', { frame_count: 36 })
  if (r.status !== 200) throw new Error(`seq create ${r.status} ${JSON.stringify(r.json)}`)
  sequenceId = r.json.sequence_id
  const files = readdirSync(FRAMES_DIR).filter((n) => n.endsWith('.png')).sort()
  const t0 = Date.now()
  for (let i = 0; i < files.length; i += 24) {
    const form = new FormData()
    files.slice(i, i + 24).forEach((n, k) => form.append(`f_${i + k + 1}`, new Blob([readFileSync(join(FRAMES_DIR, n))], { type: 'image/png' }), n))
    const up = await api(`/api/admin/360-sequences/${sequenceId}/frames`, 'POST', form)
    if (!up.json?.ok) throw new Error(`frames batch ${JSON.stringify(up.json?.failed ?? up.status)}`)
  }
  const uploadMs = Date.now() - t0
  r = await api(`/api/admin/360-sequences/${sequenceId}/complete`, 'POST')
  if (r.status !== 200) throw new Error(`complete ${r.status} ${JSON.stringify(r.json)}`)
  const commitSha = r.json.commit_sha
  r = await api(`/api/admin/360-sequences/${sequenceId}/activate`, 'POST')
  if (r.status !== 200) throw new Error(`activate ${r.status} ${JSON.stringify(r.json)}`)

  // 5) 前台数据面自检：anon 读 published_360 必须拿到 36 帧有序路径
  const pub = await fetch(`${U}/rest/v1/published_360?asset_id=eq.${assetId}&select=sequence_id,frame_count,frames`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  })
  const prow = (await pub.json())[0]
  const ordered = !!prow && prow.frames.length === 36 && prow.frames[0].index === 1 && prow.frames[35].index === 36

  mkdirSync('.scratch', { recursive: true })
  writeFileSync(
    '.scratch/c-e2e-state.json',
    JSON.stringify({ assetId, slug, langIds, imageIds, sequenceId, commitSha }, null, 2),
  )
  console.log(JSON.stringify({
    ok: true,
    assetId,
    slug,
    url: `${SITE}/asset/${slug}?lang=en`,
    sequenceId,
    commitSha,
    uploadMs,
    published360_frames: prow?.frames?.length ?? 0,
    frames_ordered_1_to_36: ordered,
  }, null, 1))
} catch (e) {
  writeFileSync('.scratch/c-e2e-state.json', JSON.stringify({ assetId, slug, langIds, imageIds, sequenceId }, null, 2))
  console.error('SETUP FAILED:', e.message)
  process.exit(1)
}
