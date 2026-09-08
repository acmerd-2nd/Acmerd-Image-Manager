#!/usr/bin/env node
/**
 * V1.3.1 跟进冒烟（隔离库 0001→0018 全量，一次性库 DROP；生产零触碰）
 * 对应 0018 迁移（Owner 2026-09-08 走查修复裁决）：
 *  T1 credit_accounts SELECT 策略含 is_admin 分支（F1 根因）
 *  T2 user_admin_notes 表 + RLS enabled + admin-all 策略（F3）
 *  T3 allowlist 44 项且含 users.notes_updated
 *  T4 触发器建户未回归：auth.users INSERT → credit_accounts 自动行
 *  T5 RLS 行为：admin 经 JWT 可读全部 credit_accounts；普通用户仅自己
 *  T6 备注写路径：admin 可 upsert 且落审计 users.notes_updated；
 *     普通用户读写被拒（RLS）；anon 被拒（grants revoke）
 * 角色模拟：postgres 是 authenticated 成员；RLS 行为一律 set local role authenticated + claims。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const getUrl = (k) => (envText.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim() ?? null
const base = getUrl('DATABASE_URL')
if (!base) throw new Error('DATABASE_URL missing in .env')

const candidates = [base]
const refMatch = new URL(base).hostname.match(/^db\.([^.]+)\.supabase\.co$/)
const projectRef = refMatch ? refMatch[1] : null
for (const h of ['aws-0-ap-northeast-1.pooler.supabase.com', 'aws-0-ap-southeast-1.pooler.supabase.com']) {
  try {
    const u = new URL(base)
    u.hostname = h
    u.port = '5432'
    if (projectRef) u.username = 'postgres.' + projectRef
    candidates.push(u.toString())
  } catch { /* skip */ }
}
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })
const DBNAME = 'acmerd_v1311_' + Date.now().toString(36).slice(-6)

async function pickMaint(log) {
  for (const cs of candidates) {
    const c = mk(cs)
    try { await c.connect(); await c.query('select 1'); log('maint OK via ' + new URL(cs).hostname); return { client: c, cs } }
    catch (e) { try { await c.end() } catch {}; log('candidate ' + new URL(cs).hostname + ' failed: ' + (e.code || e.message.slice(0, 60))) }
  }
  throw new Error('no usable maint connection')
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const U1 = '22222222-2222-4222-8222-222222222222'
const U2 = '33333333-3333-4333-8333-333333333333'
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

try {
  const picked = await pickMaint((s) => console.log('[conn] ' + s))
  mainC = picked.client
  await mainC.query('drop database if exists ' + DBNAME + ' with (force)')
  await mainC.query('create database ' + DBNAME)
  console.log('[setup] isolated db ' + DBNAME)

  dbC = mk((() => { const u = new URL(picked.cs); u.pathname = '/' + DBNAME; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)

  const migs = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of migs) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0018)')

  const q = (sql) => dbC.query(sql)

  // 用户桩：ADMIN1（admin 角色）+ U1/U2（普通）——触发器自动建 profiles/credit_accounts
  await q(`insert into auth.users (id, email) values
    ('${ADMIN1}','admin1@v1311.test'), ('${U1}','u1@v1311.test'), ('${U2}','u2@v1311.test')`)
  await q(`insert into public.user_roles (user_id, role) values ('${ADMIN1}','admin')`)

  const asUser = async (uid, fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [uid])
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }

  // ---- T1 结构 ----
  const pol = (await q(`select qual from pg_policies where schemaname='public' and tablename='credit_accounts' and policyname='credit_accounts select own or admin'`)).rows[0]
  ok('T1 credit_accounts SELECT 策略含 is_admin', !!pol && /is_admin/.test(pol.qual), pol?.qual?.slice(0, 90))

  const tbl = (await q(`select c.relrowsecurity rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='user_admin_notes'`)).rows[0]
  const npol = (await q(`select policyname, cmd from pg_policies where schemaname='public' and tablename='user_admin_notes'`)).rows
  ok('T2 user_admin_notes 存在 + RLS enabled', !!tbl && tbl.rls === true)
  ok('T2b 策略 admin-all（ALL）', npol.length === 1 && npol[0].cmd === 'ALL', JSON.stringify(npol))

  const chk = (await q(`select pg_get_constraintdef(oid) def from pg_constraint where conname='audit_logs_action_allowlist'`)).rows[0]
  ok('T3 allowlist 含 users.notes_updated', !!chk && chk.def.includes('users.notes_updated'))
  const nActions = (chk?.def.match(/'[^']+'/g) || []).length
  ok('T3b allowlist 44 项', nActions === 44, `n=${nActions}`)

  // ---- T4 触发器建户未回归 ----
  const accs = (await q(`select user_id from public.credit_accounts where user_id in ('${ADMIN1}','${U1}','${U2}')`)).rows
  ok('T4 handle_new_user 自动建户 3/3', accs.length === 3)

  // ---- T5 RLS 读取面 ----
  const seenAdmin = await asUser(ADMIN1, () => q('select count(*) n from public.credit_accounts'))
  ok('T5a admin 可读全部 credit_accounts（3）', Number(seenAdmin.rows[0].n) === 3, `n=${seenAdmin.rows[0].n}`)
  const seenU1 = await asUser(U1, () => q('select user_id from public.credit_accounts'))
  ok('T5b 普通用户仅见自己（1 行=U1）', seenU1.rows.length === 1 && seenU1.rows[0].user_id === U1)

  // ---- T6 备注写路径 ----
  await asUser(ADMIN1, () => q(`insert into public.user_admin_notes (user_id, notes) values ('${U1}', '第一批内测用户')`))
  const aud1 = (await q(`select actor_id, target_id, metadata->>'op' op from public.audit_logs where action='users.notes_updated' order by created_at desc limit 1`)).rows[0]
  ok('T6a admin 写备注成功 + 审计落档', !!aud1 && aud1.target_id === U1 && aud1.op === 'INSERT' && aud1.actor_id === ADMIN1)
  await asUser(ADMIN1, () => q(`insert into public.user_admin_notes (user_id, notes) values ('${U1}', '更新后的备注') on conflict (user_id) do update set notes = excluded.notes, updated_by = excluded.updated_by`))
  const aud2 = (await q(`select metadata->>'op' op from public.audit_logs where action='users.notes_updated' order by created_at desc limit 1`)).rows[0]
  const readBack = (await q(`select notes from public.user_admin_notes where user_id='${U1}'`)).rows[0]
  ok('T6b upsert 更新生效 + 审计 UPDATE', aud2?.op === 'UPDATE' && readBack.notes === '更新后的备注')

  const u1Read = await asUser(U1, () => q('select count(*) n from public.user_admin_notes'))
  ok('T6c 普通用户读备注 = 0 行（严格不可见）', Number(u1Read.rows[0].n) === 0)
  let denied = false
  try { await asUser(U1, () => q(`insert into public.user_admin_notes (user_id, notes) values ('${U2}', 'hack')`)) } catch (e) { denied = e.code === '42501' }
  ok('T6d 普通用户写备注被拒（42501）', denied)

  // anon（无 claim）：grants revoked → permission denied
  let anonDenied = false
  await q('begin')
  try {
    await q(`select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`)
    await q('set local role anon')
    try { await q('select count(*) from public.user_admin_notes') } catch (e) { anonDenied = e.code === '42501' }
  } finally { await q('rollback') }
  ok('T6e anon 读备注被拒（42501）', anonDenied)

  console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exitCode = 1
} catch (e) {
  console.error('[fatal]', e.message)
  process.exitCode = 1
} finally {
  try { await dbC?.end() } catch {}
  if (mainC) {
    try { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); console.log('[cleanup] isolated db dropped') } catch {}
    try { await mainC.end() } catch {}
  }
}
