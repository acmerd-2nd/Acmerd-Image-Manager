// V1.3.1 生产回归（只读）：0017 结构 + RPC 存在性 + published 视图暴露
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await c.connect()

const checks = []
const add = (name, pass, detail = '') => checks.push({ name, pass, detail })

// 1) progress 列 + CHECK
const col = await c.query(`select column_default, is_nullable from information_schema.columns
  where table_schema='public' and table_name='schedule_items' and column_name='progress'`)
add('schedule_items.progress 存在 default not_started',
  col.rows.length === 1 && col.rows[0].column_default?.includes('not_started') && col.rows[0].is_nullable === 'NO',
  JSON.stringify(col.rows[0]))

const chk = await c.query(`select conname from pg_constraint where conrelid='public.schedule_items'::regclass and conname='schedule_items_progress_check'`)
add('CHECK schedule_items_progress_check', chk.rows.length === 1)

// 2) published 视图含 progress
const v = await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name='published_schedule_items' order by ordinal_position`)
const vcols = v.rows.map((r) => r.column_name)
add('published_schedule_items 含 progress（且不含 status）', vcols.includes('progress') && !vcols.includes('status'), vcols.join(','))

// 3) RPC 存在 + 签名
const fn = await c.query(`select p.proargnames, pg_get_function_identity_arguments(p.oid) args
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='admin_batch_adjust_credits'`)
add('admin_batch_adjust_credits 存在',
  fn.rows.length === 1 && fn.rows[0].args.includes('p_user_ids') && fn.rows[0].args.includes('p_delta') && fn.rows[0].args.includes('p_reason'),
  fn.rows[0]?.args)

const ac = await c.query(`select pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='adjust_credits'`)
add('adjust_credits 5 参（含 p_operation），旧 4 参已删', ac.rows.length === 1 && ac.rows[0].args.includes('p_operation'), ac.rows[0]?.args)

// 4) migration 记录
const m = await c.query(`select filename from schema_migrations where filename like '0017%'`)
add('schema_migrations 0017 已记录', m.rows.length === 1)

// 5) 存量 schedule_items 行默认 not_started
const s = await c.query(`select count(*) n, count(*) filter (where progress='not_started') def from public.schedule_items`)
add('存量排期行 progress 全部 not_started',
  Number(s.rows[0].n) === Number(s.rows[0].def), `n=${s.rows[0].n}`)

// 6) 审计 allowlist CHECK 在且含 credits 动作
const a = await c.query(`select pg_get_constraintdef(oid) def from pg_constraint where conname='audit_logs_action_allowlist'`)
const def = a.rows[0]?.def ?? ''
add('audit allowlist 含 credits.adjusted / unlimited_changed',
  a.rows.length === 1 && def.includes('credits.adjusted') && def.includes('credits.unlimited_changed'))

await c.end()
let fail = 0
for (const k of checks) {
  console.log(`${k.pass ? 'PASS' : 'FAIL'}  ${k.name}${k.detail ? '  — ' + k.detail : ''}`)
  if (!k.pass) fail++
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
