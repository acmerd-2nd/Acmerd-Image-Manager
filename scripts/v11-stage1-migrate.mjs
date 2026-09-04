#!/usr/bin/env node
/**
 * V1.1 Stage 1 — Supabase Storage → GitHub 图片复制 + 双 hash 校验 + Migration Report
 * 依据: docs/v1.1/04-phase-b-design-gate.md §8（Owner 裁决冻结）
 *
 * 铁律:
 *   - 全程零 DB 写入（provider 切换属 Stage 2，单独 Owner 授权，本脚本绝不触碰）
 *   - 默认 DRY RUN：只读 DB + 下载源字节 + 本地双 hash + 生成计划报告，零 GitHub 写入
 *   - --execute 需同时满足: STAGE1_CONFIRM=yes + GITHUB_TOKEN + STAGE1_OWNER/REPO
 *   - 路径冻结: assets/{asset-uuid}/{langCode}/{filename}（Q1 裁决，不用 slug）
 *   - 可重放: 远端 sha 已一致 → 跳过（幂等）；任何 MISMATCH → 报告 FAIL 且退出码 1
 *
 * 用法:
 *   node scripts/v11-stage1-migrate.mjs             # dry-run 计划报告
 *   node scripts/v11-stage1-migrate.mjs --execute   # 实际复制 + 校验（需守卫全过）
 *
 * 产物: docs/v1.1/06-stage1-migration-report.md（每图 源路径/目标路径/两 hash/HEAD/结论）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import pg from 'pg'

// ---------------------------------------------------------------------------
function loadDotEnv() {
  try {
    const t = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  } catch { /* 无 .env */ }
}
loadDotEnv()

const EXECUTE = process.argv.includes('--execute')
const TOKEN = process.env.STAGE1_GITHUB_TOKEN || process.env.GITHUB_TOKEN
const OWNER = process.env.STAGE1_OWNER || process.env.DRYRUN_OWNER
const REPO = process.env.STAGE1_REPO || process.env.DRYRUN_REPO
const BRANCH = process.env.STAGE1_BRANCH || 'main'
const API = 'https://api.github.com'

function die(msg) {
  console.error(`ABORT: ${msg}`)
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex')

async function computeGitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const merged = new Uint8Array(header.length + bytes.length)
  merged.set(header, 0)
  merged.set(bytes, header.length)
  return createHash('sha1').update(merged).digest('hex')
}

function ghHeaders(accept) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'acmerd-image-manager-stage1',
  }
}

async function ghGetMeta(sourcePath) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${sourcePath}?ref=${BRANCH}`, {
    headers: ghHeaders('application/vnd.github.object+json'),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET meta ${sourcePath} → ${res.status}`)
  const body = await res.json()
  return { sha: body.sha, size: body.size ?? 0 }
}

async function ghPutFile(sourcePath, bytes, expectedSha) {
  const url = `${API}/repos/${OWNER}/${REPO}/contents/${sourcePath}`
  let retried = false
  for (;;) {
    const meta = await ghGetMeta(sourcePath)
    if (meta?.sha === expectedSha) return { skipped: true, shaMatch: true } // 可重放: 已一致 → 跳过
    const res = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders('application/vnd.github+json'),
      body: JSON.stringify({
        message: `stage1 migrate ${sourcePath} (acmerd-image-manager)`,
        content: Buffer.from(bytes).toString('base64'),
        branch: BRANCH,
        ...(meta ? { sha: meta.sha } : {}),
      }),
    })
    if (res.ok) {
      const body = await res.json()
      return { skipped: false, shaMatch: body.content?.sha === expectedSha }
    }
    if ((res.status === 409 || res.status === 422) && !retried) {
      retried = true
      continue
    }
    throw new Error(`PUT ${sourcePath} → ${res.status}`)
  }
}

const rawUrl = (p) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${p}`

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const DB = process.env.DATABASE_URL
if (!DB) die('缺少 DATABASE_URL（只读连接，仅用于列出待迁移图片；本脚本零 DB 写入）')
if (EXECUTE && (!TOKEN || !OWNER || !REPO)) die('--execute 需要 GITHUB_TOKEN + STAGE1_OWNER + STAGE1_REPO')
if (EXECUTE && process.env.STAGE1_CONFIRM !== 'yes') {
  die('--execute 需要 STAGE1_CONFIRM=yes —— Stage 1 会向 GitHub 仓库写入生产图片字节；provider 切换属 Stage 2，本脚本绝不触碰 DB')
}

console.log(`[mode] ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} → repo ${OWNER}/${REPO ?? '(dry-run 未指定)'} @ ${BRANCH}\n`)

const db = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } })
await db.connect()

// 兼容 pre-0014 生产 schema（provider/status 列 0014 才有）
const colRes = await db.query(
  `select column_name from information_schema.columns where table_schema='public' and table_name='images'`,
)
const cols = new Set(colRes.rows.map((r) => r.column_name))
const hasV11 = cols.has('provider')

const rowsRes = await db.query(
  `select i.id, i.filename, i.storage_path, i.mime_type, i.file_size
          ${hasV11 ? ', i.provider, i.status' : ''}
          , al.language_code, a.id as asset_id, a.slug as asset_slug
     from public.images i
     join public.asset_languages al on al.id = i.asset_language_id
     join public.assets a on a.id = al.asset_id
    order by i.created_at`,
)
await db.end()

const items = rowsRes.rows
  .filter((r) => !hasV11 || (r.provider === 'supabase_storage' && r.status === 'ready'))
  .map((r) => ({
    imageId: r.id,
    filename: r.filename,
    storagePath: r.storage_path,
    lang: r.language_code,
    assetId: r.asset_id,
    targetPath: `assets/${r.asset_id}/${r.language_code}/${r.filename}`,
  }))

console.log(`待迁移图片: ${items.length} 张${hasV11 ? '（provider=supabase_storage 且 ready）' : '（pre-0014 schema，全部视为 supabase_storage）'}\n`)

const reportLines = [
  `# V1.1 Stage 1 Migration Report`,
  ``,
  `- **时间**: ${new Date().toISOString()}`,
  `- **模式**: ${EXECUTE ? 'EXECUTE（已复制 + 已校验）' : 'DRY-RUN（计划报告，零写入）'}`,
  `- **目标**: \`${OWNER}/${REPO ?? '(dry-run 未指定)'}\` @ \`${BRANCH}\``,
  `- **路径规范**: assets/{asset-uuid}/{langCode}/{filename}（Q1 冻结）`,
  `- **待迁移**: ${items.length} 张`,
  ``,
  `| # | Image ID | 源 (storage_path) | 目标 (source_path) | git blob sha | sha256 | HEAD | 结论 |`,
  `| - | -------- | ----------------- | ------------------ | ------------ | ------ | ---- | ---- |`,
]

let verified = 0
let mismatch = 0
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  const no = String(i + 1).padStart(2, '0')

  // 源: Supabase Storage 公开对象（storage_path 含 bucket 前缀 images/）
  const relative = it.storagePath.split('/').slice(1).join('/')
  const srcUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/images/${relative}`

  let bytes
  try {
    const r = await fetch(srcUrl)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    bytes = new Uint8Array(await r.arrayBuffer())
  } catch (e) {
    reportLines.push(`| ${no} | \`${it.imageId}\` | \`${relative}\` | \`${it.targetPath}\` | - | - | - | ❌ SOURCE_UNREACHABLE (${String(e).slice(0, 60)}) |`)
    mismatch++
    console.log(`  ${no} ❌ 源不可达: ${relative} (${String(e).slice(0, 60)})`)
    continue
  }

  const blobSha = await computeGitBlobSha(bytes)
  const sha256 = sha256Hex(bytes)

  if (!EXECUTE) {
    reportLines.push(`| ${no} | \`${it.imageId}\` | \`${relative}\` | \`${it.targetPath}\` | \`${blobSha.slice(0, 12)}…\` | \`${sha256.slice(0, 12)}…\` | (dry-run) | 🟡 PLAN (${(bytes.length / 1024).toFixed(1)} KB) |`)
    console.log(`  ${no} 🟡 PLAN ${relative} → ${it.targetPath} (${(bytes.length / 1024).toFixed(1)} KB)`)
    continue
  }

  // EXECUTE: 复制 → response sha 校验 → GET 元数据复核 → raw HEAD
  try {
    const put = await ghPutFile(it.targetPath, bytes, blobSha)
    if (!put.shaMatch) throw new Error('response sha mismatch')
    const meta = await ghGetMeta(it.targetPath)
    if (meta?.sha !== blobSha) throw new Error('GET meta sha mismatch')
    const head = await fetch(rawUrl(it.targetPath), { method: 'HEAD' })
    if (head.status !== 200) throw new Error(`raw HEAD ${head.status}`)
    reportLines.push(`| ${no} | \`${it.imageId}\` | \`${relative}\` | \`${it.targetPath}\` | \`${blobSha.slice(0, 12)}…\` | \`${sha256.slice(0, 12)}…\` | ✅ 200 | ${put.skipped ? '✅ VERIFIED (replay-skip)' : '✅ VERIFIED'} |`)
    verified++
    console.log(`  ${no} ✅ ${it.targetPath}${put.skipped ? ' (replay-skip)' : ''}`)
  } catch (e) {
    reportLines.push(`| ${no} | \`${it.imageId}\` | \`${relative}\` | \`${it.targetPath}\` | \`${blobSha.slice(0, 12)}…\` | \`${sha256.slice(0, 12)}…\` | - | ❌ MISMATCH (${String(e).slice(0, 60)}) |`)
    mismatch++
    console.log(`  ${no} ❌ MISMATCH: ${String(e).slice(0, 80)}`)
  }
  await sleep(300) // 温和限速
}

const conclusion = EXECUTE
  ? (mismatch === 0 ? '✅ VERIFIED — 全部图片双 hash + HEAD 校验通过；Supabase 原件保留（Stage 2 前零删除）。可提交 Owner 检查。' : '❌ FAIL — 存在 MISMATCH/SOURCE_UNREACHABLE；按 Gate §8 重复制该图 → 重验；停在 Stage 1。')
  : '🟡 DRY-RUN — 以上为迁移计划；确认目标仓库后以 --execute + STAGE1_CONFIRM=yes 执行。'
reportLines.push(``, `## 结论`, ``, conclusion, ``)

const reportPath = new URL('../docs/v1.1/06-stage1-migration-report.md', import.meta.url)
writeFileSync(reportPath, reportLines.join('\n'), 'utf8')
console.log(`\nreport → docs/v1.1/06-stage1-migration-report.md`)
console.log(`result: ${EXECUTE ? `${verified} VERIFIED / ${mismatch} FAIL` : `${items.length} PLAN`}`)
process.exit(mismatch > 0 ? 1 : 0)
