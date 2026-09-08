// V1.3.1 跟进诊断（只读）：credit_accounts 缺行排查 + admin RLS 读取视角模拟
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

// 1) 全部 auth.users 与 credit_accounts 对账
const missing = (await c.query(`
  select u.id, coalesce(p.display_name,'') dn, u.email, p.account_origin
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.credit_accounts ca on ca.user_id = u.id
  where ca.user_id is null
  order by u.created_at`)).rows
console.log(`== 缺 credit_accounts 的用户（${missing.length}）==`)
for (const r of missing) console.log(`  ${r.email ?? r.id}  origin=${r.account_origin ?? '?'}`)

const all = (await c.query(`
  select count(*) users, (select count(*) from public.credit_accounts) accounts from auth.users`)).rows[0]
console.log(`auth.users=${all.users}  credit_accounts=${all.accounts}`)

// 2) 每用户账户状态摘要
const rows = (await c.query(`
  select u.email, p.account_origin, ca.balance, ca.unlimited
  from auth.users u
  left join public.profiles p on p.id=u.id
  left join public.credit_accounts ca on ca.user_id=u.id
  order by p.account_origin nulls last, u.email`)).rows
console.log('== 账户状态 ==')
for (const r of rows) console.log(`  ${r.email ?? '?'}  origin=${r.account_origin ?? '?'}  balance=${r.balance ?? 'NO-ROW'}  unlimited=${r.unlimited ?? '-'}`)

// 3) credit_accounts 的 RLS policy（admin 是否可读/写）
const pol = (await c.query(`
  select policyname, cmd, qual from pg_policies
  where schemaname='public' and tablename='credit_accounts' order by cmd, policyname`)).rows
console.log('== credit_accounts RLS ==')
for (const r of pol) console.log(`  [${r.cmd}] ${r.policyname}: ${String(r.qual).slice(0, 120)}`)

// 4) admin 视角模拟（设 admin claim 只读，验证 admin 能否经 RLS 读到所有人账户）
const admin = (await c.query(`select ur.user_id from public.user_roles ur where ur.role='admin' limit 1`)).rows[0].id
await c.query('begin')
await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [admin])
const seen = (await c.query(`select count(*) n from public.credit_accounts`)).rows[0].n
console.log(`== admin 视角 RLS 可见 credit_accounts 行数 = ${seen}（应=总账户数）==`)
await c.query('rollback')

await c.end()
