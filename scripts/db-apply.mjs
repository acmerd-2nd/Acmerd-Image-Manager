// 极简 migration 执行器：按文件名顺序执行 supabase/migrations/*.sql，
// 已执行过的记录在 schema_migrations 表中，可安全重复执行。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// 读取项目根目录 .env（不覆盖已存在的进程环境变量）
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

await client.connect()

await client.query(`
  create table if not exists schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )
`)

const dir = join(root, 'supabase', 'migrations')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const { rows } = await client.query('select filename from schema_migrations')
const applied = new Set(rows.map((r) => r.filename))

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file} (already applied)`)
    continue
  }
  const sql = readFileSync(join(dir, file), 'utf8')
  process.stdout.write(`apply ${file} ... `)
  try {
    await client.query(sql) // 简单查询协议，允许多语句
    await client.query('insert into schema_migrations (filename) values ($1)', [file])
    console.log('OK')
  } catch (err) {
    console.log('FAILED')
    console.error(err.message)
    process.exit(1)
  }
}

await client.end()
console.log('migration complete')
