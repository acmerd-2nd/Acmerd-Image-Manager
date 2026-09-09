#!/usr/bin/env node
/**
 * V1.4.2 冒烟（隔离库 0001→0021，一次性库 DROP；生产零触碰）
 * 对应 0021：published_assets 增列 collection_id（资产页面包屑）。
 *  V1 视图含 collection_id 且 grant anon select 在
 *  V2 guest 可见性零漂移：published 资产可见 / draft 不可见（where 未动）
 *  V3 collection_id 正确：无合集=null / 有合集=值
 *  V4 链断裂语义：根合集 draft → 资产行有 collection_id 但 published_collections 不含（前端不渲染面包屑）
 *  V5 anon 禁写视图（grants/RLS）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const base = (envText.match(/^DATABASE_URL=(.+)$/m) || [])[1]?.trim()
if (!base) throw new Error('DATABASE_URL missing')

const candidates = [base]
const refMatch = new URL(base).hostname.match(/^db\.([^.]+)\.supabase\.co$/)
const ref = refMatch ? refMatch[1] : null
for (const h of ['aws-0-ap-northeast-1.pooler.supabase.com', 'aws-0-ap-southeast-1.pooler.supabase.com']) {
  try {
    const u = new URL(base); u.hostname = h; u.port = '5432'
    if (ref) u.username = 'postgres.' + ref
    candidates.push(u.toString())
  } catch { /* skip */ }
}
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })
const DBNAME = 'acmerd_v142_' + Date.now().toString(36).slice(-6)

async function pickMaint(log) {
  for (const cs of candidates) {
    const c = mk(cs)
    try { await c.connect(); await c.query('select 1'); log('maint OK via ' + new URL(cs).hostname); return cs }
    catch (e) { try { await c.end() } catch {}; log('candidate failed: ' + (e.code || e.message.slice(0, 50))) }
  }
  throw new Error('no usable maint connection')
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const ROOT_STUB = `
create schema auth; create schema storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
create table storage.buckets (id text primary key, name text not null,
  public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id), name text not null,
  owner_id uuid, created_at timestamptz not null default now());
alter table storage.objects enable row level security;
grant usage on schema public, storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated, service_role;
create table if not exists public.schema_migrations (filename text primary key, applied_at timestamptz not null default now());
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

const MIG_DIR = join(root, 'supabase', 'migrations')
let mainC = null, dbC = null
const A1 = 'aaaaaaa1-0000-4000-8000-000000000001'
const A2 = 'aaaaaaa2-0000-4000-8000-000000000002'
const A3 = 'aaaaaaa3-0000-4000-8000-000000000003'
const A4 = 'aaaaaaa4-0000-4000-8000-000000000004'
const C1 = 'ccccccc1-0000-4000-8000-000000000001'
const C2 = 'ccccccc2-0000-4000-8000-000000000002'
const C3 = 'ccccccc3-0000-4000-8000-000000000003'

try {
  const cs = await pickMaint((s) => console.log('[conn] ' + s))
  mainC = mk(cs); await mainC.connect()
  await mainC.query('drop database if exists ' + DBNAME + ' with (force)')
  await mainC.query('create database ' + DBNAME)
  dbC = mk((() => { const u = new URL(cs); u.pathname = '/' + DBNAME; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  const migs = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of migs) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0021)')

  const q = (sql) => dbC.query(sql)

  // 测试数据：C1 根合集 published；C2 父 C3（draft）→ 链断裂；A1 无合集 published；A2∈C1；A3∈C2；A4 draft
  await q(`insert into public.collections (id, name, slug, status, parent_id) values
    ('${C1}','C1','c1','published',null),
    ('${C2}','C2','c2','published','${C3}'),
    ('${C3}','C3','c3','draft',null)`)
  await q(`insert into public.assets (id, name, slug, status, collection_id) values
    ('${A1}','A1','a1','published',null),
    ('${A2}','A2','a2','published','${C1}'),
    ('${A3}','A3','a3','published','${C2}'),
    ('${A4}','A4','a4','draft','${C1}')`)
  await q(`insert into public.asset_languages (asset_id, language_code, status) values
    ('${A1}','en','published'), ('${A2}','en','published'), ('${A3}','en','published'), ('${A4}','en','published')`)

  // ---- V1 结构 ----
  const col = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='published_assets' order by ordinal_position`)).rows.map((r) => r.column_name)
  ok('V1a published_assets 含 collection_id', col.includes('collection_id'), col.join(','))
  const g = (await q(`select has_table_privilege('anon','public.published_assets','select') sel,
    has_table_privilege('anon','public.published_assets','insert') ins`)).rows[0]
  ok('V1b anon select=true / insert=false', g.sel === true && g.ins === false)

  // ---- V2/V3/V4 guest 视角 ----
  await q('begin')
  await q(`select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','authenticated',true)`)
  await q('set local role authenticated')
  const rows = (await q('select slug, collection_id from public.published_assets order by slug')).rows
  const draft = (await q('select count(*) n from public.published_assets where slug=$1', ['a4'])).rows[0]
  const pubCols = (await q('select id from public.published_collections order by slug')).rows
  await q('rollback')

  ok('V2a guest 仅见 published 资产（3 行，draft 不可见）', rows.length === 3 && Number(draft.n) === 0, rows.map((r) => r.slug).join(','))
  const byslug = new Map(rows.map((r) => [r.slug, r.collection_id]))
  ok('V3a A1 无合集 = null', byslug.get('a1') === null)
  ok('V3b A2 collection_id=C1', byslug.get('a2') === C1)
  ok('V3c A3 collection_id=C2', byslug.get('a3') === C2)
  ok('V4 published_collections 仅含 C1（C2 链根 draft 不可见 → 前端不渲染面包屑）',
    pubCols.length === 1 && pubCols[0].id === C1)

  // ---- V5 anon 写被拒 ----
  let denied = false
  await q('begin')
  try {
    await q(`select set_config('request.jwt.claim.role','anon',true)`)
    await q('set local role anon')
    try { await q('update public.published_assets set name=\'x\'') } catch (e) { denied = true }
  } finally { await q('rollback') }
  ok('V5 anon 写视图被拒', denied)

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
