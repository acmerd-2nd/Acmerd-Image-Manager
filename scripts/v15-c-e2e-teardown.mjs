// V1.5 Phase C 夹具拆除：与 setup 对称，逐项经生产 Worker 端点清远端 + 删行，最后核对零残留。
// 用法：node scripts/v15-c-e2e-teardown.mjs
import { readFileSync } from 'node:fs'

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

const st = JSON.parse(readFileSync('.scratch/c-e2e-state.json', 'utf8'))
const login = await fetch(`${U}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
const jwt = (await login.json()).access_token
const authH = { Authorization: `Bearer ${jwt}` }
const api = async (path, method) => {
  const res = await fetch(`${SITE}${path}`, { method, headers: authH })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const rest = async (path, method = 'GET', body) => {
  const res = await fetch(`${U}/rest/v1/${path}`, { method, headers: svcH, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) }
}

// 1) 下线并删除 360 序列（先清指针 → 单 commit 删 36 帧 → 删行）
if (st.sequenceId) {
  const rm = await api(`/api/admin/assets/${st.assetId}/360`, 'DELETE')
  console.log('remove-active-360:', rm.status, JSON.stringify(rm.json))
}

// 2) 删除测试图片（Worker 四态闭环：远端删除成功才删行）
for (const id of st.imageIds ?? []) {
  const res = await fetch(`${SITE}/api/admin/images/github-delete`, {
    method: 'POST',
    headers: { ...authH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId: id }),
  })
  console.log('image-delete', id.slice(0, 8), res.status, JSON.stringify(await res.json().catch(() => null)))
}

// 3) 资产行（级联清 language 与任何残留 360 行）
const del = await rest(`assets?id=eq.${st.assetId}`, 'DELETE')
console.log('asset-delete:', del.status)

// 4) 零残留核对（DB + GitHub raw + published_360 视图）
const [seqLeft, frameLeft, assetLeft, pub360] = await Promise.all([
  rest(`asset_360_sequences?asset_id=eq.${st.assetId}&select=id`).then((r) => (r.json ?? []).length),
  rest(`asset_360_frames?select=id&limit=5`).then((r) => (r.json ?? []).length),
  rest(`assets?id=eq.${st.assetId}&select=id`).then((r) => (r.json ?? []).length),
  fetch(`${U}/rest/v1/published_360?select=asset_id`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }).then(async (r) => ((await r.json()) ?? []).length),
])
const frameUrl = `https://raw.githubusercontent.com/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}/main/assets/${st.assetId}/360/${st.sequenceId}/0001.png`
const gh = await fetch(frameUrl, { cache: 'no-store' })
console.log(JSON.stringify({
  sequences_for_asset: seqLeft,
  frames_total_in_db: frameLeft,
  asset_rows: assetLeft,
  published_360_rows: pub360,
  github_frame_status: gh.status,
  clean: seqLeft === 0 && frameLeft === 0 && assetLeft === 0 && pub360 === 0 && gh.status === 404,
}))
