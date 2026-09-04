#!/usr/bin/env node
/**
 * V1.1 运维：按序应用 migrations 到生产库（Owner 2026-09-04 授权）
 * 用法: node scripts/apply-migrations.mjs 0009 0010 0011 0012 0013 0014
 *   - 每个文件独立事务，失败即停（后续文件不应用）
 *   - 事前/事后打印对象存在性校验（只读）
 */
import { readFileSync, readdirSync } from 'node:fs'
import pg from 'pg'

const env = {}
for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}

const wanted = process.argv.slice(2)
if (wanted.length === 0) {
  console.error('用法: node scripts/apply-migrations.mjs <prefix...>  例: 0009 0010 0011 0012 0013 0014')
  process.exit(2)
}
const files = readdirSync(new URL('../supabase/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql') && wanted.some((p) => f.startsWith(p)))
  .sort()
console.log('将应用:', files.join(', '))

const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await db.connect()

const verify = async () => {
  const q = await db.query(`
    select
      (select count(*) from information_schema.tables where table_schema='public' and table_name in ('collections','credit_accounts','credit_transactions','site_settings','github_write_leases')) as new_tables,
      (select count(*) from information_schema.columns where table_schema='public' and table_name='images' and column_name in ('provider','source_path','source_sha','status')) as image_cols,
      (select count(*) from information_schema.routines where routine_schema='public' and routine_name in ('deduct_credits','adjust_credits','refund_credits','claim_github_lease','release_github_lease')) as rpcs`)
  const row = q.rows[0]
  try {
    row.settings_rows = (await db.query('select count(*)::int as c from public.site_settings')).rows[0].c
  } catch {
    row.settings_rows = -1
  }
  return row
}
console.log('事前:', JSON.stringify(await verify()))

for (const f of files) {
  const sql = readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')
  try {
    await db.query('begin')
    await db.query(sql)
    await db.query('commit')
    console.log(`✅ ${f}`)
  } catch (e) {
    await db.query('rollback').catch(() => {})
    console.error(`❌ ${f}: ${e.message}`)
    process.exit(1)
  }
}
console.log('事后:', JSON.stringify(await verify()))
await db.end()
console.log('DONE')
