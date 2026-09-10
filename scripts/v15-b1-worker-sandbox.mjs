// V1.5 Phase B1：360° Viewer Worker 集成层沙箱验证（Gate docs/v1.5/02 §G3 + D2/D3/D4）
// 前置：本地 wrangler dev --test-scheduled（端口 8787，.dev.vars 指生产 Supabase + 真实 GitHub 仓库）。
//       e2e9 前缀测试资产 + finally 清零；审计行留痕符合既有惯例（同 v12-a-worker-sandbox 范式）。
// 用法：
//   node node_modules/wrangler/wrangler-dist/cli.js dev --port 8787 --test-scheduled  （另开终端）
//   node scripts/v15-b1-worker-sandbox.mjs
// 覆盖：创建/清单/分批传帧/complete（含幂等）/activate（含非 ready 409 + 守卫）/
//       缺帧 409 / SHA 污染注入 / 删除（active 409 → 下线 → 目录单 commit 删）/
//       单 commit 证据（commits?path 计数）/ sweeper 收敛（uploading 缺帧→failed；deleting→物理删）
import { readFileSync } from 'node:fs'

for (const f of ['.env', '.dev.vars']) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const BASE = process.env.WORKER_BASE ?? 'http://127.0.0.1:8787'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const P = 'e2e9'
const GH = `https://api.github.com/repos/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}`
const GH_HEADERS = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'acmerd-b1-sandbox',
}

// 1x1 PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- admin JWT（GoTrue password grant，凭据不落输出）----
const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
})
if (!loginRes.ok) { console.error('admin login failed', loginRes.status); process.exit(1) }
const jwt = (await loginRes.json()).access_token
const auth = { Authorization: `Bearer ${jwt}` }

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body instanceof FormData ? auth : { ...auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const svcHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const svcRest = async (path, method = 'GET', body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: svcHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, json }
}
const auditCount = async (action) => {
  const r = await svcRest(`audit_logs?action=eq.${action}&select=id`, 'GET')
  return (r.json ?? []).length
}
const auditBefore = {}
const auditDelta = async (action) => (await auditCount(action)) - (auditBefore[action] ?? 0)
const snapshotAudit = async (...actions) => { for (const a of actions) auditBefore[a] = await auditCount(a) }

// ---- GitHub 侧：目录 commit 计数 / 单帧 meta ----
const commitsForPath = async (dir) => {
  const res = await fetch(`${GH}/commits?sha=${process.env.GITHUB_IMAGES_BRANCH}&path=${encodeURIComponent(dir)}&per_page=100`, { headers: GH_HEADERS })
  if (!res.ok) return null
  return (await res.json()).length
}
const frameMeta = async (path) => {
  const res = await fetch(`${GH}/contents/${encodeURI(path)}?ref=${process.env.GITHUB_IMAGES_BRANCH}`, { headers: GH_HEADERS })
  if (!res.ok) return null
  return (await res.json())
}

// ---- 测试资产（service_role 直插，e2e9 前缀；沙箱数据，非生产内容）----
const ASSET_ID = crypto.randomUUID()
let r = await svcRest('assets', 'POST', { id: ASSET_ID, name: `${P} test`, slug: `${P}-test`, status: 'draft' })
if (r.status >= 300) { console.error('asset insert failed', r.status, JSON.stringify(r.json)); process.exit(1) }

const cleanup = async () => {
  // 资产删除级联 sequences/frames；GitHub 目录若残留由下一条命令报告
  await svcRest(`assets?id=eq.${ASSET_ID}`, 'DELETE')
}
process.on('exit', () => {})
try {
  await snapshotAudit('360.sequence.created', '360.sequence.activated', '360.sequence.deleted', '360.upload.failed')

  // ---- W1 创建序列（36）+ 预生成帧行 ----
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`, 'POST', { frame_count: 36 })
  ok('W1 创建 36 帧 200 + sequence_id + 36 帧行', r.status === 200 && r.json?.sequence_id && r.json?.frames?.length === 36, JSON.stringify(r.json).slice(0, 140))
  const SEQ1 = r.json?.sequence_id
  ok('W1 source_path 命名 assets/{asset}/360/{seq}/0001.png', r.json?.frames?.[0]?.source_path === `assets/${ASSET_ID}/360/${SEQ1}/0001.png`)

  // ---- W2 非法 frame_count 400 ----
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`, 'POST', { frame_count: 50 })
  ok('W2 frame_count=50 → 400 bad_request', r.status === 400 && r.json?.error?.code === 'bad_request', JSON.stringify(r.json).slice(0, 100))

  // ---- W3 complete 缺帧 → 409 frames_incomplete（校验响应：不改状态机、不写审计，允许继续补传）----
  r = await api(`/api/admin/360-sequences/${SEQ1}/complete`, 'POST')
  ok('W3 缺帧 complete → 409 frames_incomplete（expected=36）', r.status === 409 && r.json?.error?.code === 'frames_incomplete' && r.json?.error?.expected === 36, JSON.stringify(r.json).slice(0, 140))
  ok('W3b 状态机保持 draft（可继续补传）', (await svcRest(`asset_360_sequences?id=eq.${SEQ1}&select=status`)).json?.[0]?.status === 'draft')
  ok('W3c 校验响应不写 360.upload.failed', (await auditDelta('360.upload.failed')) === 0)

  // ---- W4 activate 非 ready → 409 ----
  r = await api(`/api/admin/360-sequences/${SEQ1}/activate`, 'POST')
  ok('W4 activate failed 序列 → 409 invalid_state', r.status === 409 && r.json?.error?.code === 'invalid_state', JSON.stringify(r.json).slice(0, 100))

  // ---- W5 分批传帧（36 = 2 批：20 + 16；FRAME_BATCH_MAX=20，见 0023/CF 子请求配额）----
  const mkForm = (from, to) => {
    const fd = new FormData()
    for (let i = from; i <= to; i++) fd.append(`f_${i}`, new Blob([PNG_1X1], { type: 'image/png' }), `${String(i).padStart(4, '0')}.png`)
    return fd
  }
  r = await api(`/api/admin/360-sequences/${SEQ1}/frames`, 'POST', mkForm(1, 20))
  ok('W5 批 1（f_1..f_20）全成功', r.status === 200 && r.json?.ok === true && r.json?.uploaded?.length === 20, JSON.stringify(r.json?.failed ?? '').slice(0, 200))
  r = await api(`/api/admin/360-sequences/${SEQ1}/frames`, 'POST', mkForm(21, 36))
  ok('W5 批 2（f_21..f_36）全成功', r.status === 200 && r.json?.ok === true && r.json?.uploaded?.length === 16, JSON.stringify(r.json?.failed ?? '').slice(0, 200))

  // 越界帧拒绝（批内失败计数）
  const badForm = new FormData()
  badForm.append('f_37', new Blob([PNG_1X1], { type: 'image/png' }), '0037.png')
  r = await api(`/api/admin/360-sequences/${SEQ1}/frames`, 'POST', badForm)
  ok('W5b 越界帧 f_37 → ok=false（批内失败）', r.status === 200 && r.json?.ok === false && r.json?.failed?.[0]?.frame_index === 37, JSON.stringify(r.json).slice(0, 160))

  // 序列状态 uploading
  const seqUp = await svcRest(`asset_360_sequences?id=eq.${SEQ1}&select=status`)
  ok('W5c 序列状态 → uploading', seqUp.json?.[0]?.status === 'uploading')

  // ---- W6 complete → 200 + commit_sha；GitHub 该目录 commit 计数 = 1 ----
  r = await api(`/api/admin/360-sequences/${SEQ1}/complete`, 'POST')
  ok('W6 complete 200 + commit_sha', r.status === 200 && typeof r.json?.commit_sha === 'string' && r.json?.commit_sha.length === 40, JSON.stringify(r.json).slice(0, 140))
  await sleep(1500) // GitHub 索引延迟容忍
  let cnt = await commitsForPath(`assets/${ASSET_ID}/360/${SEQ1}`)
  ok('W6b GitHub 目录 commit 计数 = 1（Git Data API 单提交）', cnt === 1, `count=${cnt}`)
  const meta1 = await frameMeta(`assets/${ASSET_ID}/360/${SEQ1}/0001.png`)
  ok('W6c 首帧远端存在 + 序列 ready', !!meta1 && meta1.sha?.length === 40)
  const seqReady = await svcRest(`asset_360_sequences?id=eq.${SEQ1}&select=status,source_sha`)
  ok('W6d DB ready + source_sha=commit_sha', seqReady.json?.[0]?.status === 'ready' && seqReady.json?.[0]?.source_sha === r.json?.commit_sha)

  // ---- W7 complete 幂等：重复调用 200 already=true，commit 计数不变 ----
  r = await api(`/api/admin/360-sequences/${SEQ1}/complete`, 'POST')
  ok('W7 重复 complete → already=true', r.status === 200 && r.json?.already === true, JSON.stringify(r.json).slice(0, 100))
  cnt = await commitsForPath(`assets/${ASSET_ID}/360/${SEQ1}`)
  ok('W7b commit 计数仍 = 1', cnt === 1, `count=${cnt}`)

  // ---- W8 SHA 污染注入：置 failed（绕开 ready 幂等）→ 帧首帧 blob_sha 改错 → complete 失败；恢复后收敛 ----
  const framesRows = (await svcRest(`asset_360_frames?sequence_id=eq.${SEQ1}&select=id,frame_index,blob_sha,source_path`)).json
  const f1 = framesRows.find((f) => f.frame_index === 1)
  await svcRest(`asset_360_sequences?id=eq.${SEQ1}`, 'PATCH', { status: 'failed' })
  await svcRest(`asset_360_frames?id=eq.${f1.id}`, 'PATCH', { blob_sha: '1234567890123456789012345678901234567890' })
  r = await api(`/api/admin/360-sequences/${SEQ1}/complete`, 'POST')
  ok('W8 污染首帧 sha complete → 非 2xx', r.status >= 400 && r.status < 600, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 120)}`)
  const seqFail = await svcRest(`asset_360_sequences?id=eq.${SEQ1}&select=status`)
  ok('W8b 序列收敛为 failed（tree 拒绝或抽验失败）', seqFail.json?.[0]?.status === 'failed', `status=${seqFail.json?.[0]?.status}`)
  await svcRest(`asset_360_frames?id=eq.${f1.id}`, 'PATCH', { blob_sha: f1.blob_sha })
  r = await api(`/api/admin/360-sequences/${SEQ1}/complete`, 'POST')
  ok('W8c 恢复后 complete 重新收敛 200', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 100))
  // 完整性核验：抽 3 帧远端 sha 必须与 DB 登记一致（污染期间若 GH 接受坏 sha 产生了坏 commit，最终态也必须干净）
  let shaAllMatch = true
  for (const idx of [1, 18, 36]) {
    const row = framesRows.find((f) => f.frame_index === idx)
    const meta = await frameMeta(row.source_path)
    if (!meta || meta.sha !== row.blob_sha) shaAllMatch = false
  }
  ok('W8d 抽验帧 1/18/36 远端 sha === DB 登记值', shaAllMatch)
  cnt = await commitsForPath(`assets/${ASSET_ID}/360/${SEQ1}`)
  ok('W8e commits?path 计数 = 1（污染未产生提交；收敛 commit 树内容一致不计路径变更）', cnt === 1, `count=${cnt}`)

  // ---- W9 激活 + 审计 + activated 指针 ----
  r = await api(`/api/admin/360-sequences/${SEQ1}/activate`, 'POST')
  ok('W9 activate 200', r.status === 200, JSON.stringify(r.json).slice(0, 100))
  const act = await svcRest(`assets?id=eq.${ASSET_ID}&select=active_360_sequence_id`)
  ok('W9b assets.active_360_sequence_id → SEQ1', act.json?.[0]?.active_360_sequence_id === SEQ1)
  ok('W9c 审计 360.sequence.activated +1', (await auditDelta('360.sequence.activated')) === 1)

  // ---- W10 删除 active 序列 → 409 sequence_is_active ----
  r = await api(`/api/admin/360-sequences/${SEQ1}`, 'DELETE')
  ok('W10 删除 active → 409 sequence_is_active', r.status === 409 && r.json?.error?.code === 'sequence_is_active', JSON.stringify(r.json).slice(0, 100))

  // ---- W11 清单端点：is_active/uploaded_frames ----
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`)
  const s1 = r.json?.sequences?.find((s) => s.id === SEQ1)
  ok('W11 清单 200：SEQ1 ready is_active uploaded_frames=36', r.status === 200 && s1?.status === 'ready' && s1?.is_active === true && s1?.uploaded_frames === 36, JSON.stringify(r.json).slice(0, 200))

  // ---- W12 移除 active（[7]）：指针先空 → 目录删除 → 行删除 ----
  r = await api(`/api/admin/assets/${ASSET_ID}/360`, 'DELETE')
  ok('W12 移除 active 200 + removed=true', r.status === 200 && r.json?.removed === true, JSON.stringify(r.json).slice(0, 100))
  const act2 = await svcRest(`assets?id=eq.${ASSET_ID}&select=active_360_sequence_id`)
  ok('W12b 指针已空', act2.json?.[0]?.active_360_sequence_id === null)
  const rowsGone = await svcRest(`asset_360_sequences?id=eq.${SEQ1}&select=id`)
  ok('W12c 序列行已物理删除', (rowsGone.json ?? []).length === 0)
  await sleep(1500)
  const metaGone = await frameMeta(`assets/${ASSET_ID}/360/${SEQ1}/0001.png`)
  ok('W12d GitHub 首帧已删（404）', metaGone === null)
  ok('W12e 审计 360.sequence.deleted +1', (await auditDelta('360.sequence.deleted')) === 1)

  // ---- W13 sweeper 收敛（--test-scheduled）----
  // 13a：uploading + 缺帧 → failed + 审计 sweeper_incomplete
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`, 'POST', { frame_count: 36 })
  const SEQ2 = r.json?.sequence_id
  await svcRest(`asset_360_sequences?id=eq.${SEQ2}`, 'PATCH', { status: 'uploading' })
  r = await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`, { method: 'POST' })
  await sleep(8000) // sweeper 内部 fetch 链 + GH 网络耗时
  const seq2Now = await svcRest(`asset_360_sequences?id=eq.${SEQ2}&select=status`)
  ok('W13a sweeper：uploading 缺帧 → failed', seq2Now.json?.[0]?.status === 'failed', `status=${seq2Now.json?.[0]?.status}`)
  const swAudit = await svcRest(`audit_logs?action=eq.360.upload.failed&order=created_at.desc&limit=1&select=metadata`)
  ok('W13b sweeper 审计 stage=sweeper_incomplete', JSON.stringify(swAudit.json?.[0]?.metadata ?? {}).includes('sweeper_incomplete'))

  // 13c：deleting（无远端文件）→ 物理删行
  r = await api(`/api/admin/assets/${ASSET_ID}/360-sequences`, 'POST', { frame_count: 36 })
  const SEQ3 = r.json?.sequence_id
  await svcRest(`asset_360_sequences?id=eq.${SEQ3}`, 'PATCH', { status: 'deleting' })
  await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`, { method: 'POST' })
  await sleep(8000)
  const seq3Gone = await svcRest(`asset_360_sequences?id=eq.${SEQ3}&select=id`)
  ok('W13c sweeper：deleting → 物理删行', (seq3Gone.json ?? []).length === 0)

  // ---- W14 非 admin JWT → 401/403 ----
  const anonRes = await fetch(`${BASE}/api/admin/assets/${ASSET_ID}/360-sequences`, { headers: { 'Content-Type': 'application/json' } })
  ok('W14 无凭据 → 401/403', anonRes.status === 401 || anonRes.status === 403, `status=${anonRes.status}`)

  console.log(`\n${pass} PASS / ${fail} FAIL`)
} finally {
  await cleanup()
  console.log('cleanup done (e2e9 asset cascade-deleted; GitHub 目录由 W12 单 commit 清空)')
}
process.exit(fail > 0 ? 1 : 0)
