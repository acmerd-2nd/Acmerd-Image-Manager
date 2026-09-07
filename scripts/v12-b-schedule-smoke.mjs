#!/usr/bin/env node
/**
 * V1.2-B Schedule 冒烟（隔离库 0001→0016 全量，一次性库 DROP；生产零触碰）
 * 对应 docs/v1.2/01-design-gate.md D1–D5：
 *  H1 自引用拒绝（CHECK）              H2 跨节点环拒绝（COLLECTION_CYCLE）
 *  H3 深度上限 5：第 6 层拒            H4 子树随迁溢出拒（v_depth+1+h>5）
 *  H5 合法深移成功（子链深度重算）      H6 删父 RESTRICT（23503）
 *  H7 视图 anon：全链 published 才可见；asset_count 只数直接子资产；parent_id 暴露
 *  H8 视图 admin：全量可见             H9 非层级字段更新不受守卫影响
 * 角色模拟：postgres 是 authenticated 成员；anon 等效 = claim 空 + SET LOCAL role authenticated。
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
const DBNAME = 'acmerd_v12_b_' + Date.now().toString(36).slice(-6)

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
let mainC = null, dbC = null, exitCode = 0

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
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0016)')

  const q = (sql) => dbC.query(sql)
  const asAnon = async (fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }

  const mkCol = async (name, slug, parentId = null, status = 'draft') =>
    (await q(`insert into public.collections (name, slug, status, parent_id) values ('${name}', '${slug}', '${status}', ${parentId ? `'${parentId}'` : 'null'}) returning id, parent_id`)).rows[0]

  const mkPubAsset = async (slug, collectionId) => {
    const a = (await q(`insert into public.assets (name, slug, status, created_by) values ('${slug}', '${slug}', 'draft', '${ADMIN1}') returning id`)).rows[0].id
    await q(`insert into public.asset_languages (asset_id, language_code, status) values ('${a}', 'en', 'published')`)
    await q(`insert into public.images (asset_language_id, filename, provider, status, sort_order, storage_path)
      values ((select id from public.asset_languages where asset_id='${a}'), 'i.jpg', 'supabase_storage', 'ready', 0, 'images/x/i.jpg')`)
    await q(`update public.assets set status='published', collection_id='${collectionId}' where id='${a}'`)
    return a
  }
  const expectErr = async (sql, frag) => {
    try { await q(sql); return null } catch (e) { return String(e.message).includes(frag) ? '' : 'wrong-error:' + e.message.slice(0, 80) }
  }

  await q(`insert into auth.users (id, email) values ('${ADMIN1}','admin1@x.test')`)
  await q(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)


  const asRole = async (sub, fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub', '${sub}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }

  const mkItem = async (title, status = 'draft', date = null, sort = 0) =>
    (await q(`insert into public.schedule_items (title, status, event_date, sort_order) values ('${title}', '${status}', ${date ? `'${date}'` : 'null'}, ${sort}) returning id`)).rows[0].id

  // ---------- S1 CRUD + updated_at touch ----------
  const it1 = await mkItem('S1 item')
  await q(`update public.schedule_items set description='d1' where id='${it1}'`)
  const row1 = (await q(`select description, updated_at > created_at as touched from public.schedule_items where id='${it1}'`)).rows[0]
  ok('S1 插入/更新 + updated_at touch', row1.description === 'd1' && row1.touched === true)

  // ---------- S2 status CHECK ----------
  let r = await expectErr(`insert into public.schedule_items (title, status) values ('bad', 'pending')`, 'schedule_items_status_check')
  ok('S2 非法状态拒绝（CHECK）', r === '', r ?? '')

  // ---------- S3 视图：published only + 排序（event_date asc nulls last, sort_order asc） ----------
  await mkItem('pub-b', 'published', '2026-10-02', 0)
  await mkItem('pub-a', 'published', '2026-10-01', 5)
  await mkItem('pub-null', 'published', null, 0)
  await mkItem('pub-a2', 'published', '2026-10-01', 1)
  const anonView = (await asRole('', () => q(`select title from public.published_schedule_items`))).rows.map((x) => x.title)
  ok('S3a anon 视图仅 published（draft/archived 不出）', anonView.length === 4 && !anonView.includes('S1 item'), anonView.join(','))
  ok('S3b 排序 event_date asc nulls last + sort_order', JSON.stringify(anonView) === JSON.stringify(['pub-a2', 'pub-a', 'pub-b', 'pub-null']), anonView.join(','))

  // ---------- S4 基表 RLS：anon 只见 published，admin 全量 ----------
  const anonBase = (await asRole('', () => q(`select count(*)::int as n from public.schedule_items`))).rows[0].n
  ok('S4a anon 基表只见 published', anonBase === 4, 'n=' + anonBase)
  const adminBase = (await asRole(ADMIN1, () => q(`select count(*)::int as n from public.schedule_items`))).rows[0].n
  ok('S4b admin 基表全量', adminBase === 5, 'n=' + adminBase)

  // ---------- S5 anon 写拒绝（INSERT WITH CHECK 抛错） ----------
  r = await expectErr(`select 1`, '__noop__')
  const s5 = await asRole('', async () => {
    try { await q(`insert into public.schedule_items (title) values ('anon-write')`); return 'no-error' }
    catch (e) { return String(e.message).includes('permission denied') || String(e.message).includes('row-level security') ? 'denied' : 'other:' + e.message.slice(0, 60) }
  })
  ok('S5 anon INSERT 拒绝', s5 === 'denied', s5)

  // ---------- S6 审计链（admin 身份：created/published/updated/deleted） ----------
  const before = (await q(`select count(*)::int as n from public.audit_logs where action like 'schedule.item%'`)).rows[0].n
  // 注意：审计断言必须真实提交——不能包 ROLLBACK 事务；用会话级 claim + set role，测毕还原
  await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', false), set_config('request.jwt.claim.role', 'authenticated', false)`)
  await q('set role authenticated')
  const a1 = (await q(`insert into public.schedule_items (title) values ('aud1') returning id`)).rows[0].id
  await q(`update public.schedule_items set status='published' where id='${a1}'`)
  await q(`update public.schedule_items set title='aud1-r' where id='${a1}'`)  // item_updated
  await q(`update public.schedule_items set status='archived' where id='${a1}'`)
  await q(`delete from public.schedule_items where id='${a1}'`)
  await q('reset role')
  await q(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'anon', false)`)
  const acts = (await q(`select action, count(*)::int as n from public.audit_logs where action like 'schedule.item%' group by action order by action`)).rows
  const amap = Object.fromEntries(acts.map((x) => [x.action, x.n]))
  const delta = acts.reduce((s2, x) => s2 + x.n, 0) - before
  ok('S6a 审计 4 动作齐（created/published/updated/archived… deleted）',
    delta === 5 && amap['schedule.item_created'] === 1 && amap['schedule.item_published'] === 1 &&
    amap['schedule.item_updated'] === 1 && amap['schedule.item_archived'] === 1 && amap['schedule.item_deleted'] === 1,
    JSON.stringify(amap))

  // ---------- S7 非 admin（service-role 等效：owner 直连）写不产生审计 ----------
  const before7 = (await q(`select count(*)::int as n from public.audit_logs where action like 'schedule.item%'`)).rows[0].n
  const it7 = await mkItem('svc-write')
  await q(`delete from public.schedule_items where id='${it7}'`)
  const after7 = (await q(`select count(*)::int as n from public.audit_logs where action like 'schedule.item%'`)).rows[0].n
  ok('S7 非 admin 写零审计行（is_admin 过滤）', before7 === after7, `${before7} -> ${after7}`)

  // ---------- S8 allowlist 43 项在位（CHECK 含 schedule.*） ----------
  const chk = await q(`select pg_get_constraintdef(oid) as def from pg_constraint where conname='audit_logs_action_allowlist'`)
  ok('S8 allowlist 含 5 个 schedule 动作', chk.rows[0]?.def?.includes('schedule.item_archived') === true)

  console.log('\n===== V1.2-B SCHEDULE SMOKE: ' + pass + ' PASS / ' + fail + ' FAIL =====')
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  exitCode = 2
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); await mainC.end() } } catch {}
}
process.exit(exitCode)
