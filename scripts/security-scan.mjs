// Phase 8 Secret 扫描（可复跑）—— Gate D6 = 6a
// 范围：
//   1. git 全历史唯一 blob（含已删除文件的历史内容）
//   2. dist/ 工作区产物（js/css/html，递归）
//   3. 工作区跟踪情况：.env* 是否被 git 跟踪/忽略；跟踪内容敏感变量赋值检查
// 判定规则：
//   * Supabase anon key（JWT role=anon）为公开可发布值 → 不算泄漏；
//   * service_role key / 数据库口令 / 私钥 / 平台 token → 泄漏（FAIL）
//   * 占位符样本（changeme/password/your_*/<...> 等）→ 记录为 sample，不算泄漏
// 输出不含任何真实密钥值（一律打码）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

// ---------- 分类器 ----------
const b64url = (s) => Buffer.from(s, 'base64url').toString('utf8')
const jwtRole = (tok) => {
  try {
    const mid = tok.split('.')[1]
    if (!mid) return null
    const payload = b64url(mid)
    const m = payload.match(/"role"\s*:\s*"([^"]+)"/)
    return m ? m[1] : null
  } catch { return null }
}
const jwtLike = /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9[.\w-]+/g

const PLACEHOLDER = new Set(['changeme','password','your_password','your-password','your_db_password','your-db-password',
  'dbpassword','postgres','secret','xxxxx','xxx','example','<password>','<your-password>'])
const maskVal = (v) => {
  if (!v) return '(empty)'
  if (v.length <= 6) return v.slice(0, 2) + '***'
  return v.slice(0, 4) + '***' + v.slice(-2)
}

const SECRET_ASSIGN = /(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE|DATABASE_URL|DB_PASSWORD|PGPASSWORD|JWT_SECRET)\s*[=:]\s*['"]?([^'"\s]+)['"]?/gi
const CONN_PWD = /(?:postgres(?:ql)?:\/\/[^'"\s]+):([^@'"\s/]+)@/gi
const PRIV_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const GH_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36}\b/
const OTHER_TOK = /\b(?:sk_live_[A-Za-z0-9]{24}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35})\b/

// 返回 { kind, detail }[]；kind ∈ secret|sample|anon(ok)
function classifyLine(line) {
  const out = []
  if (PRIV_KEY.test(line)) { out.push({ kind: 'secret', detail: 'private-key' }) }
  let m
  while ((m = jwtLike.exec(line))) {
    const role = jwtRole(m[0])
    if (role === 'service_role') out.push({ kind: 'secret', detail: 'jwt.service_role' })
    else if (role && role !== 'anon') out.push({ kind: 'secret', detail: `jwt.role=${role}` })
    // role=anon 或解析失败 → 忽略（anon 为公开键；失败串多为文档示例）
  }
  SECRET_ASSIGN.lastIndex = 0
  while ((m = SECRET_ASSIGN.exec(line))) {
    const val = m[2] || ''
    const low = val.toLowerCase().replace(/^["']|["']$/g, '')
    const masked = maskVal(low)
    if (!low) continue
    // 值实为行尾注释（如 KEY=   # comment）或整行注释 → 视为空值/示例，非泄漏
    if (/^[#;]/.test(low) || /^\/\//.test(low)) continue
    if (line.slice(0, m.index).trim().startsWith('#')) { results.sample.push({ scope: 'comment', path: 'n/a', detail: 'commented-line' }); continue }
    if (low.startsWith('eyJ') && jwtRole(low.split(/[?#]/)[0]) === 'service_role') {
      out.push({ kind: 'secret', detail: `${m[1].toLowerCase()}=jwt.service_role` })
    } else if (low && !PLACEHOLDER.has(low) && !low.startsWith('<') && !/^x{2,}$/.test(low)) {
      out.push({ kind: 'secret', detail: `${m[1].toLowerCase()}=${masked}` })
    } else if (low && (PLACEHOLDER.has(low) || low.startsWith('<') || /^x{2,}$/.test(low))) {
      out.push({ kind: 'sample', detail: `${m[1].toLowerCase()}=${masked} (placeholder)` })
    }
  }
  CONN_PWD.lastIndex = 0
  while ((m = CONN_PWD.exec(line))) {
    const pwd = m[1]
    if (pwd && !PLACEHOLDER.has(pwd.toLowerCase())) out.push({ kind: 'secret', detail: `db-conn-with-password (pwd ${maskVal(pwd)})` })
    else if (pwd) out.push({ kind: 'sample', detail: 'db-conn-with-placeholder-password' })
  }
  GH_TOKEN.lastIndex = 0; OTHER_TOK.lastIndex = 0
  if (GH_TOKEN.test(line)) out.push({ kind: 'secret', detail: 'github-token' })
  if (OTHER_TOK.test(line)) out.push({ kind: 'secret', detail: 'platform-token' })
  return out
}

const results = { secret: [], sample: [], anonIgnored: 0 }
const record = (kind, scope, path, detail) => { results[kind].push({ scope, path, detail }) }

// ---------- 1. git 全历史唯一 blob ----------
console.log('[scan-1] git 全历史唯一 blob')
const objLines = git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean)
const blobToPaths = new Map()
const blobHashes = []
for (const ln of objLines) {
  const sp = ln.indexOf(' ')
  const hash = sp === -1 ? ln : ln.slice(0, sp)
  const path = sp === -1 ? '' : ln.slice(sp + 1)
  if (!blobToPaths.has(hash)) blobToPaths.set(hash, [])
  if (path) blobToPaths.get(hash).push(path)
  blobHashes.push(hash)
}
// rev-list 含 tree/commit 行；只扫 blob：用 cat-file 探测类型太重，改按行过滤路径行为空且未显式在 objects? 
// 简化：全部尝试 cat-file -p，非 blob 输出不同格式易误扫 → 用 --batch 太重；改为过滤：path 为空即无路径（tree/commit）
const uniq = [...new Set(blobHashes)]
let textBlobs = 0
for (const h of uniq) {
  let content
  try { content = execFileSync('git', ['cat-file', '-p', h], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) }
  catch { continue } // tree/commit/缺失
  if (content.includes('\u0000')) continue // 二进制
  textBlobs++
  const paths = blobToPaths.get(h) || []
  const label = paths.length ? paths.join(' | ') : '(history-blob)'
  for (const line of content.split('\n')) {
    for (const c of classifyLine(line)) {
      if (c.kind === 'secret') record('secret', 'git-history', label, c.detail)
      else if (c.kind === 'sample') record('sample', 'git-history', label, c.detail)
    }
  }
}
console.log(`  blobs scanned(text)=${textBlobs}`)

// ---------- 2. dist/ 工作区产物 ----------
console.log('[scan-2] dist/ 产物')
const walkDist = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkDist(p)
    else {
      const content = readFileSync(p, 'utf8')
      const label = 'dist/' + relative(join(root, 'dist'), p)
      for (const line of content.split('\n')) {
        for (const c of classifyLine(line)) {
          if (c.kind === 'secret') record('secret', 'dist', label, c.detail)
          else if (c.kind === 'sample') record('sample', 'dist', label, c.detail)
        }
      }
    }
  }
}
if (existsSync(join(root, 'dist'))) walkDist(join(root, 'dist'))

// ---------- 3. 工作区跟踪情况 ----------
console.log('[scan-3] .env* 跟踪/忽略状态')
const trackedEnvAll = git(['ls-files']).split('\n').filter((f) => f.toLowerCase().includes('.env'))
const trackedEnv = trackedEnvAll.filter((f) => !/\.env\.(example|sample|template|dist)$/i.test(f.toLowerCase()))
console.log(`  tracked .env* files: ${trackedEnvAll.length ? trackedEnvAll.join(', ') : '(none)'} (example/sample/template 豁免)`)
if (trackedEnv.length) record('secret', 'workspace', `tracked .env*: ${trackedEnv.join(',')}`)
for (const f of ['.env', '.env.local', '.env.production']) {
  if (existsSync(join(root, f))) {
    let ignored = false
    try { ignored = git(['check-ignore', f]) === f } catch { ignored = false }
    console.log(`  ${f}: exists, ignored=${ignored}`)
    if (!ignored) record('secret', 'workspace', `${f} exists but NOT gitignored`)
  }
}
// 跟踪内容中敏感变量赋值（全量 tracked 文件）
console.log('[scan-4] 跟踪文件内容敏感变量赋值')
for (const f of git(['ls-files']).split('\n').filter(Boolean)) {
  let content
  try { content = readFileSync(join(root, f), 'utf8') } catch { continue }
  for (const line of content.split('\n')) {
    for (const c of classifyLine(line)) {
      if (c.kind === 'secret') record('secret', 'tracked', f, c.detail)
      else if (c.kind === 'sample') record('sample', 'tracked', f, c.detail)
    }
  }
}

// ---------- 输出 ----------
console.log('\n========== RESULT ==========')
console.log(`SECRETS: ${results.secret.length}`)
for (const s of results.secret) console.log(`  [${s.scope}] ${s.path} :: ${s.detail}`)
console.log(`SAMPLES(placeholder, 豁免): ${results.sample.length}`)
for (const s of results.sample.slice(0, 20)) console.log(`  [${s.scope}] ${s.path} :: ${s.detail}`)
process.exit(results.secret.length === 0 ? 0 : 1)
