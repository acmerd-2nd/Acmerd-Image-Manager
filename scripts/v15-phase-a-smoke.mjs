#!/usr/bin/env node
/**
 * V1.5 Phase A 冒烟（隔离库 0001→0022，一次性库 DROP；生产零触碰）
 * 对应 docs/v1.5/02-design-gate.md：
 *  S1 结构：两表/CHECK（非法 frame_count 拒绝）/唯一索引/FK
 *  S2 守卫触发器：active 指向异 asset 或非 ready → 拒；合法激活 → 通过
 *  S3 RLS：guest 只见 ready 序列及其帧（draft/uploading 隐藏）；admin 全见；guest 零写
 *  S4 published_360 视图：仅 published asset ⋈ active ready；帧按 index 排序；
 *     非 active 的 ready 序列不出现；draft 资产不出现
 *  S5 FK on delete set null：删序列 → assets.active 复位 null
 *  S6 allowlist 48 项且含 360.*；360.sequence.created 可入审计
 * 角色模拟：RLS 行为 set local role authenticated + claims（v1311/v142 教训：
 * 写路径审计/断言如需真实落库用 commit 事务；本阶段纯 RLS/结构，rollback 即可）
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
const DBNAME = 'acmerd_v15a_' + Date.now().toString(36).slice(-6)

async function pickMaint(log) {
  for (const cs of candidates) {
    const c = mk(cs)
    c.on('error', () => {})
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

const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const U1 = '22222222-2222-4222-8222-222222222222'
const AS1 = 'aaaaaaa1-0000-4000-8000-000000000001' // published asset（带 360）
const AS2 = 'aaaaaaa2-0000-4000-8000-000000000002' // draft asset
const SQ_READY = 'bbbbbbb1-0000-4000-8000-000000000001' // ready + active
const SQ_READY2 = 'bbbbbbb2-0000-4000-8000-000000000002' // ready 但非 active
const SQ_UP = 'bbbbbbb3-0000-4000-8000-000000000003' // uploading

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

try {
  const cs = await pickMaint((s) => console.log('[conn] ' + s))
  mainC = mk(cs); await mainC.connect()
  mainC.on('error', () => {})
  await mainC.query('drop database if exists ' + DBNAME + ' with (force)')
  await mainC.query('create database ' + DBNAME)
  dbC = mk((() => { const u = new URL(cs); u.pathname = '/' + DBNAME; return u.toString() })())
  dbC.on('error', () => {})
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  const migs = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of migs) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0022)')

  const q = (sql) => dbC.query(sql)

  // 用户与资产桩
  await q(`insert into auth.users (id, email) values ('${ADMIN1}','a@t.test'), ('${U1}','u@t.test')`)
  await q(`insert into public.user_roles (user_id, role) values ('${ADMIN1}','admin') on conflict (user_id) do update set role='admin'`)
  await q(`insert into public.assets (id, name, slug, status) values ('${AS1}','A1','a1','draft'), ('${AS2}','A2','a2','draft')`)
  await q(`insert into public.asset_languages (asset_id, language_code, status) values ('${AS1}','en','published')`)
  await q(`insert into public.images (asset_language_id, filename, storage_path, status)
    select al.id, 'stub.jpg', 'stub/x.jpg', 'ready' from public.asset_languages al where al.asset_id='${AS1}'`)
  await q(`update public.assets set status='published' where id='${AS1}'`)

  // 序列桩（postgres 直插 = Worker service_role 语义）
  await q(`insert into public.asset_360_sequences (id, asset_id, frame_count, status) values
    ('${SQ_READY}','${AS1}',36,'ready'),
    ('${SQ_READY2}','${AS1}',72,'ready'),
    ('${SQ_UP}','${AS1}',144,'uploading')`)
  await q(`insert into public.asset_360_frames (sequence_id, frame_index, source_path, status) values
    ('${SQ_READY}',2,'assets/${AS1}/360/${SQ_READY}/0002.png','ready'),
    ('${SQ_READY}',1,'assets/${AS1}/360/${SQ_READY}/0001.png','ready'),
    ('${SQ_UP}',1,'assets/${AS1}/360/${SQ_UP}/0001.png','uploading')`)

  const asAdmin = async (fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub','${ADMIN1}',true), set_config('request.jwt.claim.role','authenticated',true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }
  const asGuest = async (fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','authenticated',true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }

  // ---- S1 结构 ----
  const chk = (await q(`select conname from pg_constraint where conrelid='public.asset_360_sequences'::regclass and conname like '%frame_count%'`)).rows.length
  ok('S1a frame_count CHECK 在', chk === 1)
  let badRejected = false
  try { await q(`insert into public.asset_360_sequences (asset_id, frame_count, status) values ('${AS1}',48,'draft')`) } catch (e) { badRejected = e.code === '23514' }
  ok('S1b 非法帧数 48 拒绝（23514）', badRejected)
  const dup = (await q(`select count(*) n from pg_indexes where tablename='asset_360_frames' and indexdef like '%UNIQUE%'`)).rows[0].n
  ok('S1c (sequence_id,frame_index) 唯一索引', Number(dup) >= 1)

  // ---- S2 守卫触发器 ----
  let g1 = null
  try { await q(`update public.assets set active_360_sequence_id='${SQ_UP}' where id='${AS1}'`) } catch (e) { g1 = e.message }
  ok('S2a active 指向 uploading 序列被拒', g1?.includes('360_ACTIVE_INVALID'))
  let g2 = null
  try { await q(`update public.assets set active_360_sequence_id='${SQ_READY}' where id='${AS2}'`) } catch (e) { g2 = e.message }
  ok('S2b active 指向异 asset 序列被拒', g2?.includes('360_ACTIVE_INVALID'))
  await q(`update public.assets set active_360_sequence_id='${SQ_READY}' where id='${AS1}'`)
  const act = (await q(`select active_360_sequence_id from public.assets where id='${AS1}'`)).rows[0].active_360_sequence_id
  ok('S2c 合法激活通过', act === SQ_READY)

  // ---- S3 RLS ----
  const guestSeq = await asGuest(() => q(`select id, status from public.asset_360_sequences order by id`))
  ok('S3a guest 仅见 ready 序列（2/3，uploading 隐藏）',
    guestSeq.rows.length === 2 && guestSeq.rows.every((r) => r.status === 'ready'))
  const guestFrames = await asGuest(() => q(`select f.frame_index from public.asset_360_frames f join public.asset_360_sequences s on s.id=f.sequence_id where s.id='${SQ_READY}' order by f.frame_index`))
  ok('S3b guest 见 ready 序列帧（乱序插入按查询排好）',
    guestSeq.rows.some((r) => r.id === SQ_READY) && guestFrames.rows.map((r) => r.frame_index).join(',') === '1,2')
  const adminSeq = await asAdmin(() => q(`select count(*) n from public.asset_360_sequences`))
  ok('S3c admin 全见（3）', Number(adminSeq.rows[0].n) === 3)
  let wDenied = false
  await asGuest(async () => { try { await q(`insert into public.asset_360_sequences (asset_id, frame_count, status) values ('${AS1}',36,'draft')`) } catch (e) { wDenied = true } })
  ok('S3d guest 写序列被拒（RLS/授权）', wDenied)

  // ---- S4 published_360 视图 ----
  await asGuest(async () => {})
  const v = (await q(`select * from public.published_360 where asset_id='${AS1}'`)).rows[0]
  ok('S4a 视图输出 active ready 序列 + 帧按 index 排序',
    !!v && v.sequence_id === SQ_READY && v.frame_count === 36 &&
    v.frames.map((f) => f.index).join(',') === '1,2' &&
    v.frames[0].path.endsWith('/0001.png'))
  const vCount = (await q(`select count(*) n from public.published_360`)).rows[0].n
  ok('S4b 非 active ready 序列/未发布资产不出现（仅 1 行）', Number(vCount) === 1)

  // ---- S5 FK set null ----
  await q(`delete from public.asset_360_sequences where id='${SQ_READY}'`)
  const act2 = (await q(`select active_360_sequence_id from public.assets where id='${AS1}'`)).rows[0].active_360_sequence_id
  ok('S5 删序列 → assets.active 复位 null', act2 === null)

  // ---- S6 allowlist ----
  const def = (await q(`select pg_get_constraintdef(oid) def from pg_constraint where conname='audit_logs_action_allowlist'`)).rows[0].def
  const n = (def.match(/'[^']+'/g) || []).length
  ok('S6a allowlist 48 项', n === 48, `n=${n}`)
  ok('S6b 含 360.sequence.created/activated/deleted + 360.upload.failed',
    def.includes('360.sequence.created') && def.includes('360.sequence.activated') &&
    def.includes('360.sequence.deleted') && def.includes('360.upload.failed'))
  const aud = (await q(`insert into public.audit_logs (actor_id, action, target_type, target_id) values ('${ADMIN1}','360.sequence.created','asset_360_sequences','${SQ_READY}') returning id`)).rows.length
  ok('S6c 360.sequence.created 可落审计', aud === 1)

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
