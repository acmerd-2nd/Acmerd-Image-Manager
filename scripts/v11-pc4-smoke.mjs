#!/usr/bin/env node
/**
 * V1.1 PC-4 冒烟（隔离库，生产零触碰）
 * 验证 PC-4 Worker 接线所依赖的 0010 RPC 语义（复用既有 RPC，零新 RPC 零 schema）：
 *  K1  deduct_credits 正常扣分 + ledger 落行（amount 为负、balance_after 正确）
 *  K2  H2 幂等：同 key 同参 → 原结果（不重复扣）
 *  K3  H2 冲突：同 key 异参 → IDEMPOTENCY_CONFLICT
 *  K4  余额不足 → INSUFFICIENT_CREDITS（Worker 映射 402）
 *  K5  unlimited=true → 旁路（不扣不写流水）
 *  K6  并发同 key：unique 兜底裁决（预插 ledger 模拟竞态输家）
 *  K7  refund_credits：一 debit 一 refund；重复 refund 幂等返回
 *  K8  adjust_credits：Set Balance 语义 + admin_adjustment 流水
 *  K9  定价：cost 从 site_settings 读取
 *  K10 service_role 身份防线：非 service_role 调用被拒
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const getUrl = (k) => {
  const m = envText.match(new RegExp('^' + k + '=(.+)$', 'm'))
  return m ? m[1].trim() : null
}
const base = getUrl('DATABASE_URL')
if (!base) throw new Error('DATABASE_URL missing in .env')

const candidates = [base]
for (const h of ['aws-0-ap-northeast-1.pooler.supabase.com', 'aws-0-ap-southeast-1.pooler.supabase.com']) {
  try {
    const u = new URL(base)
    u.hostname = h
    u.port = '5432'
    u.username = 'postgres.' + (u.username.split('.')[0] || 'postgres')
    candidates.push(u.toString())
  } catch { /* skip */ }
}
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })

const DBNAME = 'acmerd_v11_c4_' + Date.now().toString(36).slice(-6)

async function pickMaint(log) {
  for (const cs of candidates) {
    const c = mk(cs)
    try {
      await c.connect()
      await c.query('select 1')
      log('maint connection OK via ' + new URL(cs).hostname)
      return { client: c, cs }
    } catch (e) {
      try { await c.end() } catch {}
      log('candidate ' + new URL(cs).hostname + ' failed: ' + (e.code || e.message.slice(0, 60)))
    }
  }
  throw new Error('no usable maint connection')
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const USER1 = '22222222-2222-4222-8222-222222222222'
const USER2 = '33333333-3333-4333-8333-333333333333'
const ROOT_STUB = `
create schema auth; create schema storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key, email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table storage.buckets (
  id text primary key, name text not null,
  public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null, owner_id uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
grant usage on schema public, storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated, service_role;
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

const MIG_DIR = join(root, 'supabase', 'migrations')

let mainC = null, dbC = null
let exitCode = 0
try {
  const picked = await pickMaint((s) => console.log('[conn] ' + s))
  mainC = picked.client
  await mainC.query('drop database if exists ' + DBNAME + ' with (force)')
  await mainC.query('create database ' + DBNAME)
  console.log('[setup] isolated db ' + DBNAME + ' created')

  dbC = mk((() => { const u = new URL(picked.cs); u.pathname = '/' + DBNAME; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)

  const migs = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of migs) {
    await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  }
  console.log('[migrate] all ' + migs.length + ' migrations applied')

  const q = (sql) => dbC.query(sql)

  // ---------- seed ----------
  await q("insert into auth.users (id, email) values ('" + ADMIN1 + "','admin1@x.test'), ('" + USER1 + "','user1@x.test'), ('" + USER2 + "','user2@x.test')")
  await q("update public.user_roles set role='admin' where user_id='" + ADMIN1 + "'")
  await q("update public.credit_accounts set balance=10 where user_id='" + USER1 + "'")
  await q("update public.credit_accounts set balance=5, unlimited=true where user_id='" + USER2 + "'")

  // service_role 身份模拟（Worker svc() 语义）：claim.role=service_role
  const asSvc = async (fn) => {
    await q("select set_config('request.jwt.claim.role', 'service_role', false)")
    try { return await fn() } finally { await q("select set_config('request.jwt.claim.role', '', false)") }
  }

  // ---------- K1：正常扣分 ----------
  const k1 = await asSvc(async () => {
    const r = await q("select deduct_credits('" + USER1 + "','image_download',1,null,'image','img-1','{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const k1row = await q("select amount, balance_after from public.credit_transactions where user_id='" + USER1 + "' and type='image_download' and reference_id='img-1'")
  ok('K1 deduct works + ledger row', Number(k1) === 9 && k1row.rows.length === 1 && Number(k1row.rows[0].amount) === -1 && Number(k1row.rows[0].balance_after) === 9, 'bal=' + k1)

  // ---------- K2：同 key 同参 → 原结果 ----------
  const k2a = await asSvc(async () => {
    const r = await q("select deduct_credits('" + USER1 + "','image_download',1,'key-replay','image','img-2','{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const k2b = await asSvc(async () => {
    const r = await q("select deduct_credits('" + USER1 + "','image_download',1,'key-replay','image','img-2','{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const k2count = (await q("select count(*)::int as n from public.credit_transactions where reference_id='img-2'")).rows[0].n
  ok('K2 same key+params replay returns original', Number(k2a) === 8 && Number(k2b) === 8 && k2count === 1, 'a=' + k2a + ' b=' + k2b + ' ledger=' + k2count)

  // ---------- K3：同 key 异参 → IDEMPOTENCY_CONFLICT ----------
  const k3 = await asSvc(async () => {
    try {
      await q("select deduct_credits('" + USER1 + "','image_download',2,'key-replay','image','img-2','{}'::jsonb)")
      return false
    } catch (e) { return /IDEMPOTENCY_CONFLICT/.test(e.message) }
  })
  ok('K3 same key different params conflicts', k3)

  // ---------- K4：余额不足 → INSUFFICIENT_CREDITS ----------
  const k4 = await asSvc(async () => {
    try {
      await q("select deduct_credits('" + USER1 + "','package_download',999,null,'download_source','src-1','{}'::jsonb)")
      return false
    } catch (e) { return /INSUFFICIENT_CREDITS/.test(e.message) }
  })
  ok('K4 insufficient → INSUFFICIENT_CREDITS', k4)
  const k4bal = Number((await q("select balance from public.credit_accounts where user_id='" + USER1 + "'")).rows[0].balance)
  ok('K4b balance unchanged after reject', k4bal === 8, 'bal=' + k4bal)

  // ---------- K5：unlimited 旁路 ----------
  const k5 = await asSvc(async () => {
    const r = await q("select deduct_credits('" + USER2 + "','zip_download',7,null,'zip','zip-1','{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const k5count = (await q("select count(*)::int as n from public.credit_transactions where reference_id='zip-1'")).rows[0].n
  const k5bal = Number((await q("select balance from public.credit_accounts where user_id='" + USER2 + "'")).rows[0].balance)
  ok('K5 unlimited bypass (no deduction no ledger)', Number(k5) === 5 && k5count === 0 && k5bal === 5, 'ret=' + k5 + ' ledger=' + k5count)

  // ---------- K6：并发同 key unique 兜底（预插 ledger 行模拟竞态输家） ----------
  await asSvc(async () => {
    await q("insert into public.credit_transactions (user_id, type, amount, balance_after, reference_type, reference_id, idempotency_key) values ('" + USER1 + "','image_download',-1,7,'image','img-3','key-race')")
  })
  const k6 = await asSvc(async () => {
    const r = await q("select deduct_credits('" + USER1 + "','image_download',1,'key-race','image','img-3','{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  ok('K6 concurrent same-key converges via unique', Number(k6) === 7, 'ret=' + k6)
  const k6bal = Number((await q("select balance from public.credit_accounts where user_id='" + USER1 + "'")).rows[0].balance)
  ok('K6b no double deduction (balance stays 8)', k6bal === 8, 'bal=' + k6bal)

  // ---------- K7：refund 一 debit 一 refund ----------
  const debitRow = (await q("select id from public.credit_transactions where user_id='" + USER1 + "' and type='image_download' and reference_id='img-2'")).rows[0]
  const r1 = await asSvc(async () => {
    const r = await q("select refund_credits(" + debitRow.id + ",null,'{\"reason\":\"test\"}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const r2 = await asSvc(async () => {
    const r = await q("select refund_credits(" + debitRow.id + ",null,'{}'::jsonb) as bal")
    return r.rows[0].bal
  })
  const refundCount = (await q("select count(*)::int as n from public.credit_transactions where type='download_refund' and reference_id='" + debitRow.id + "'")).rows[0].n
  ok('K7 refund once + idempotent repeat', Number(r1) === 9 && Number(r2) === 9 && refundCount === 1, 'r1=' + r1 + ' r2=' + r2 + ' refunds=' + refundCount)

  // ---------- K8：adjust_credits Set Balance ----------
  const k8 = await asSvc(async () => {
    const r = await q("select adjust_credits('" + USER1 + "', 120, 'promo', null) as bal")
    return r.rows[0].bal
  })
  const k8tx = (await q("select amount, balance_after from public.credit_transactions where user_id='" + USER1 + "' and type='admin_adjustment' order by id desc limit 1")).rows[0]
  ok('K8 set-balance + ledger row', Number(k8) === 120 && Number(k8tx.amount) === 111 && Number(k8tx.balance_after) === 120,
    'bal=' + k8 + ' amount=' + k8tx.amount)

  // ---------- K9：settings 数值可读 ----------
  const k9 = (await q("select value from public.site_settings where key='single_image_download_cost'")).rows[0]
  ok('K9 settings cost readable', Number(k9.value) === 1, 'value=' + JSON.stringify(k9.value))

  // ---------- K10：非 service_role 调用被拒（grants 收敛：revoke from public/authenticated） ----------
  // set_config 只改 claim 不改实际角色——postgres 是表 owner 不受 revoke 限制，
  // 必须 SET ROLE authenticated 才能测真实客户端权限面（0010 revoke + grant 仅 service_role）。
  const k10denied = await (async () => {
    await q("set local role authenticated") // 需事务
    return null
  })()
  let k10a = false, k10b = false, k10msg = ""
  await q('begin')
  await q("set local role authenticated")
  try {
    await q("select deduct_credits('" + USER1 + "','image_download',1,null,'image','img-x','{}'::jsonb)")
  } catch (e) { k10msg = e.message; k10a = /denied|FORBIDDEN|permission/.test(e.message) }
  await q('rollback')
  await q('begin')
  await q("set local role authenticated")
  try {
    await q("select adjust_credits('" + USER1 + "', 1, null, null)")
  } catch (e) { k10b = /denied|FORBIDDEN|permission/.test(e.message) }
  await q('rollback')
  ok('K10 authenticated cannot execute deduct_credits (grants)', k10a, k10msg.slice(0, 80))
  ok('K10b authenticated cannot execute adjust_credits (grants)', k10b)

  console.log('\n===== PC-4 SMOKE: ' + pass + ' PASS / ' + fail + ' FAIL =====')
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  exitCode = 2
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); await mainC.end() } } catch {}
}
process.exit(exitCode)
