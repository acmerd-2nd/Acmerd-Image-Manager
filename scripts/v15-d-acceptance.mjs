// V1.5 Phase D：360° 后端验收矩阵（生产 Worker + 生产库 + 真实图片仓，可复跑）
// 覆盖规格 §53 的 Admin/规格/Download 面 + Gate §G3 崩溃收敛之外的全部服务端断言：
//   四规格(36/72/144/360)真实上传、数量/格式/体积/越界负样本、complete 幂等、
//   激活与守卫、active 不可直删、替换→清理旧版、单 commit 证据、下载与积分隔离、审计四动作。
// 用法：node scripts/v15-d-acceptance.mjs        （结束自动清理；--keep 保留夹具供前台探针复用）
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

for (const f of ['.env', '.dev.vars']) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const SITE = process.env.ACCEPT_BASE ?? 'https://image.acmerd.com'
const U = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const KEEP = process.argv.includes('--keep')
const FRAMES = '.scratch/360-frames-360'
const svcH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const GH = `https://api.github.com/repos/${process.env.GITHUB_IMAGES_OWNER}/${process.env.GITHUB_IMAGES_REPO}`
const ghH = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'acmerd-d-acceptance' }

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
const tok = await login.json()
const jwt = tok.access_token
const adminId = JSON.parse(atob(jwt.split('.')[1])).sub
const authH = { Authorization: `Bearer ${jwt}` }

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${SITE}${path}`, {
    method,
    headers: body instanceof FormData ? authH : { ...authH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const rest = async (path, method = 'GET', body, repr = false) => {
  const headers = repr ? { ...svcH, Prefer: 'return=representation' } : svcH
  const res = await fetch(`${U}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) }
}
const anonRest = async (path) => {
  const res = await fetch(`${U}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })
  return res.status === 200 ? await res.json() : { __status: res.status }
}
const commitsForPath = async (dir) => {
  const res = await fetch(`${GH}/commits?sha=${process.env.GITHUB_IMAGES_BRANCH}&path=${encodeURIComponent(dir)}&per_page=100`, { headers: ghH })
  return res.ok ? (await res.json()).length : null
}
const remoteSha = async (path) => {
  const res = await fetch(`${GH}/contents/${encodeURI(path)}?ref=${process.env.GITHUB_IMAGES_BRANCH}`, { headers: ghH })
  return res.ok ? (await res.json()).sha : null
}
const auditCount = async (action) => ((await (await fetch(`${U}/rest/v1/audit_logs?action=eq.${action}&select=id`, { headers: svcH })).json()).length)

if (!existsSync(FRAMES)) { console.error(`缺少帧素材 ${FRAMES}：先跑 node scripts/tools/gen-360-frames.mjs ${FRAMES} 360`); process.exit(1) }
const allFiles = readdirSync(FRAMES).filter((n) => n.endsWith('.png')).sort()
const frameBlob = (i) => new Blob([readFileSync(join(FRAMES, allFiles[i - 1]))], { type: 'image/png' })

const assetId = crypto.randomUUID()
const seqIds = {}
const auditBase = {}
const timings = {}

try {
  await Promise.all(['360.sequence.created', '360.sequence.activated', '360.sequence.deleted', '360.upload.failed'].map(async (a) => { auditBase[a] = await auditCount(a) }))
  const credBefore = (await rest(`credit_accounts?user_id=eq.${adminId}&select=balance`)).json?.[0]?.balance ?? null

  let r = await rest('assets', 'POST', { id: assetId, name: 'e2e-d 验收', slug: `e2e-d-${assetId.slice(0, 8)}`, status: 'draft' })
  if (r.status >= 300) { console.error('asset insert failed', r.status, JSON.stringify(r.json)); process.exit(1) }
  const langRow = (await rest('asset_languages', 'POST', { asset_id: assetId, language_code: 'en', status: 'draft' }, true)).json?.[0]

  // ---------- N1 负样本：格式 / 体积 / 越界（单帧失败不中断整批） ----------
  r = await api(`/api/admin/assets/${assetId}/360-sequences`, 'POST', { frame_count: 36 })
  seqIds.neg = r.json.sequence_id
  const bad = new FormData()
  bad.append('f_1', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'bad.txt')
  bad.append('f_2', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png')
  bad.append('f_999', frameBlob(1), '0001.png')
  r = await api(`/api/admin/360-sequences/${seqIds.neg}/frames`, 'POST', bad)
  const errs = Object.fromEntries((r.json?.failed ?? []).map((f) => [f.frame_index, f.error]))
  ok('N1a 非 PNG 帧被拒（Unsupported type）', /Unsupported type/.test(errs[1] ?? ''), errs[1])
  ok('N1b 超 5MB 帧被拒（File too large）', /File too large/.test(errs[2] ?? ''), errs[2])
  ok('N1c 越界帧号被拒（out of range）', /out of range/.test(errs[999] ?? ''), errs[999])
  ok('N1d 批内失败不阻断（ok=false 且逐帧回执）', r.status === 200 && r.json?.ok === false && r.json?.failed?.length === 3)

  // ---------- N2 complete 缺帧 → 409；序列保持可续传 ----------
  r = await api(`/api/admin/360-sequences/${seqIds.neg}/complete`, 'POST')
  ok('N2 缺帧 complete → 409 frames_incomplete', r.status === 409 && r.json?.error?.code === 'frames_incomplete')
  r = await api(`/api/admin/360-sequences/${seqIds.neg}/activate`, 'POST')
  ok('N2b 激活非 ready → 409 invalid_state', r.status === 409 && r.json?.error?.code === 'invalid_state')

  // ---------- N3 单请求帧数上限（Gate D3 + CF 子请求配额：≤20） ----------
  const tooMany = new FormData()
  for (let i = 1; i <= 21; i++) tooMany.append(`f_${i}`, frameBlob(i), allFiles[i - 1])
  r = await api(`/api/admin/360-sequences/${seqIds.neg}/frames`, 'POST', tooMany)
  ok('N3 21 帧/请求 → 400 批量上限', r.status === 400 && /max 20/.test(r.json?.error?.message ?? ''), JSON.stringify(r.json).slice(0, 90))

  // ---------- D1 四规格真实上传（含吞吐计时） ----------
  for (const n of [36, 72, 144, 360]) {
    r = await api(`/api/admin/assets/${assetId}/360-sequences`, 'POST', { frame_count: n })
    const sid = r.json.sequence_id
    seqIds[n] = sid
    const t0 = Date.now()
    let uploaded = 0
    for (let i = 0; i < n; i += 20) {
      const form = new FormData()
      for (let k = i; k < Math.min(i + 20, n); k++) form.append(`f_${k + 1}`, frameBlob(k + 1), allFiles[k])
      const up = await api(`/api/admin/360-sequences/${sid}/frames`, 'POST', form)
      if (!up.json?.ok) throw new Error(`${n} 帧批次失败: ${JSON.stringify(up.json?.failed)?.slice(0, 160)}`)
      uploaded += up.json.uploaded.length
    }
    const uploadMs = Date.now() - t0
    timings[n] = { uploadMs, frames: uploaded, perFrameMs: +(uploadMs / n).toFixed(1) }
    r = await api(`/api/admin/360-sequences/${sid}/complete`, 'POST')
    const dir = `assets/${assetId}/360/${sid}`
    const cnt = await commitsForPath(dir)
    const rows = await rest(`asset_360_frames?sequence_id=eq.${sid}&select=frame_index,source_path,blob_sha,status&order=frame_index.asc`)
    const first = rows.json?.[0], last = rows.json?.[rows.json.length - 1]
    const [shaFirst, shaLast] = await Promise.all([remoteSha(first.source_path), remoteSha(last.source_path)])
    ok(`D1 ${n} 帧：全部登记且 ready`, uploaded === n && rows.json?.length === n && rows.json.every((f) => f.status === 'ready' && !!f.blob_sha), `uploaded=${uploaded} rows=${rows.json?.length}`)
    ok(`D1 ${n} 帧：远端 sha === DB 登记（首/末帧）`, shaFirst === first.blob_sha && shaLast === last.blob_sha, `first ${shaFirst?.slice(0, 7)}/${first.blob_sha?.slice(0, 7)} last ${shaLast?.slice(0, 7)}/${last.blob_sha?.slice(0, 7)}`)
    ok(`D1 ${n} 帧：GitHub 目录 commit 数 = 1（Git Data API 单提交）`, cnt === 1, `count=${cnt}`)
    ok(`D1 ${n} 帧：complete 返回 commit_sha 且 sequence ready`, r.status === 200 && typeof r.json?.commit_sha === 'string')
  }

  // ---------- D2 complete 幂等（重复调用不产生新提交） ----------
  r = await api(`/api/admin/360-sequences/${seqIds[36]}/complete`, 'POST')
  ok('D2 重复 complete → already=true', r.status === 200 && r.json?.already === true)
  ok('D2b commit 数仍为 1', (await commitsForPath(`assets/${assetId}/360/${seqIds[36]}`)) === 1)

  // ---------- D3 激活 → active 不可直删 → 替换 → 清理旧版 ----------
  r = await api(`/api/admin/360-sequences/${seqIds[360]}/activate`, 'POST')
  ok('D3 激活 360 帧序列 200', r.status === 200)
  let ptr = (await rest(`assets?id=eq.${assetId}&select=active_360_sequence_id`)).json?.[0]?.active_360_sequence_id
  ok('D3b 指针指向 360 帧序列', ptr === seqIds[360])
  r = await api(`/api/admin/360-sequences/${seqIds[360]}`, 'DELETE')
  ok('D3c 直删 active → 409 sequence_is_active', r.status === 409 && r.json?.error?.code === 'sequence_is_active')

  r = await api(`/api/admin/360-sequences/${seqIds[144]}/activate`, 'POST')
  ok('D3d 原子切换到 144 帧序列（无空窗：一次 UPDATE 完成）', r.status === 200)
  ptr = (await rest(`assets?id=eq.${assetId}&select=active_360_sequence_id`)).json?.[0]?.active_360_sequence_id
  ok('D3e 切换后指针 = 144 帧序列，旧 360 序列仍在（可回滚）', ptr === seqIds[144] && (await rest(`asset_360_sequences?id=eq.${seqIds[360]}&select=status`)).json?.[0]?.status === 'ready')
  r = await api(`/api/admin/360-sequences/${seqIds[360]}`, 'DELETE')
  ok('D3f 清理被替换的旧序列 200', r.status === 200 && r.json?.removed_remote_files === 360)
  ok('D3g 旧序列远端目录已清空', (await remoteSha(`assets/${assetId}/360/${seqIds[360]}/0001.png`)) === null)

  // ---------- D4 下载与积分隔离（规格 §32/§33/§34） ----------
  const someFrame = (await rest(`asset_360_frames?sequence_id=eq.${seqIds[144]}&select=id&limit=1`)).json?.[0]
  const dl = await fetch(`${SITE}/api/downloads/image/${someFrame.id}`, { headers: authH })
  ok('D4a 360 帧 id 不能走单图下载端点', dl.status !== 200, `status=${dl.status}`)
  const imgs = await rest(`images?asset_language_id=eq.${langRow?.id}&select=id`)
  ok('D4b 该资产语言的 images 为 0 行（360 帧不进普通图片体系 → ZIP/Package 天然不含）', (imgs.json ?? []).length === 0, `rows=${(imgs.json ?? []).length}`)
  const credAfter = (await rest(`credit_accounts?user_id=eq.${adminId}&select=balance`)).json?.[0]?.balance ?? null
  ok('D4c 全程 360 操作未改变积分余额', credBefore === credAfter, `${credBefore} → ${credAfter}`)
  const pkg = await api(`/api/admin/assets/${assetId}/360-sequences`)
  ok('D4d 清单端点不回帧 URL（前台仅经 published_360 + make360FrameUrl 出图）', JSON.stringify(pkg.json).includes('raw.githubusercontent') === false)

  // ---------- D5 审计四动作（规格 §48） ----------
  const dCreated = (await auditCount('360.sequence.created')) - auditBase['360.sequence.created']
  const dAct = (await auditCount('360.sequence.activated')) - auditBase['360.sequence.activated']
  const dDel = (await auditCount('360.sequence.deleted')) - auditBase['360.sequence.deleted']
  const dFail = (await auditCount('360.upload.failed')) - auditBase['360.upload.failed']
  ok('D5a 审计 360.sequence.created（draft + complete 两阶段）', dCreated >= 12, `delta=${dCreated}`)
  ok('D5b 审计 360.sequence.activated ×2（两次激活）', dAct === 2, `delta=${dAct}`)
  ok('D5c 审计 360.sequence.deleted ≥1', dDel >= 1, `delta=${dDel}`)
  ok('D5d 校验型 409 不写故障审计（缺帧/越界均无 360.upload.failed）', dFail === 0, `delta=${dFail}`)

  // ---------- D6 移除 active 的安全顺序（§47） ----------
  r = await api(`/api/admin/assets/${assetId}/360`, 'DELETE')
  ok('D6 移除 active 200 + 远端 144 帧清空', r.status === 200 && r.json?.removed_remote_files === 144, JSON.stringify(r.json))
  ok('D6b 指针先置 null', (await rest(`assets?id=eq.${assetId}&select=active_360_sequence_id`)).json?.[0]?.active_360_sequence_id === null)
  ok('D6c 视图 anon 读不到该资产 360（已下线）', ((await anonRest(`published_360?asset_id=eq.${assetId}&select=sequence_id`)) ?? []).length === 0)

  console.log('\n吞吐计时（4 路并发，真实 GitHub）：')
  for (const n of [36, 72, 144, 360]) console.log(`  ${String(n).padStart(3)} 帧: ${timings[n].uploadMs} ms  (${timings[n].perFrameMs} ms/帧)`)
} finally {
  if (!KEEP) {
    const left = (await rest(`asset_360_sequences?asset_id=eq.${assetId}&select=id,status`)).json ?? []
    for (const s of left) {
      if (s.status === 'deleting') continue
      await api(`/api/admin/360-sequences/${s.id}`, 'DELETE').catch(() => {})
    }
    await rest(`assets?id=eq.${assetId}`, 'DELETE')
    const seq = (await rest(`asset_360_sequences?asset_id=eq.${assetId}&select=id`)).json ?? []
    const frames = (await rest(`asset_360_frames?sequence_id=in.(${Object.values(seqIds).filter(Boolean).join(',')})&select=id`)).json ?? []
    const pub = (await anonRest(`published_360?asset_id=eq.${assetId}&select=sequence_id`)) ?? []
    ok('Z1 夹具清零（本夹具序列/帧/视图）', seq.length === 0 && frames.length === 0 && (Array.isArray(pub) ? pub.length === 0 : false), `seq=${seq.length} frames=${frames.length}`)
    const dirs = Object.values(seqIds).filter(Boolean)
    let ghClean = true
    for (const sid of dirs) {
      if ((await remoteSha(`assets/${assetId}/360/${sid}/0001.png`)) !== null) ghClean = false
    }
    ok('Z2 GitHub 各密度目录均已移除', ghClean)
  } else {
    writeFileSync('.scratch/d-acceptance-state.json', JSON.stringify({ assetId, seqIds }, null, 2))
    console.log('  (--keep) 夹具保留：', assetId, JSON.stringify(seqIds))
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`)
}
process.exit(fail > 0 ? 1 : 0)
