#!/usr/bin/env node
/**
 * V1.2-A 多层 Folder 冒烟（隔离库 0001→0015 全量，一次性库 DROP；生产零触碰）
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
const DBNAME = 'acmerd_v12_h_' + Date.now().toString(36).slice(-6)

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
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0015)')

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

  // ---------- H1 自引用 ----------
  const idSelf = '22222222-2222-4222-8222-222222222222'
  let r = await expectErr(
    `insert into public.collections (id, name, slug, parent_id) values ('${idSelf}', 'Self', 'h1-self', '${idSelf}')`,
    'COLLECTION_PARENT_SELF')
  ok('H1 自引用 CHECK 拒绝', r === '', r ?? '')

  // ---------- H2 跨节点环 ----------
  const A = (await mkCol('A', 'h2-a')).id
  const B = (await mkCol('B', 'h2-b', A)).id
  r = await expectErr(`update public.collections set parent_id='${B}' where id='${A}'`, 'COLLECTION_CYCLE')
  ok('H2 A→B→A 环拒绝', r === '', r ?? '')

  // ---------- H3 深度上限 5 ----------
  const d1 = A
  const d2 = (await mkCol('D2', 'h3-d2', d1)).id
  const d3 = (await mkCol('D3', 'h3-d3', d2)).id
  const d4 = (await mkCol('D4', 'h3-d4', d3)).id
  const d5 = (await mkCol('D5', 'h3-d5', d4)).id
  ok('H3a 第 5 层允许', !!d5)
  r = await expectErr(`insert into public.collections (name, slug, parent_id) values ('D6', 'h3-d6', '${d5}')`, 'COLLECTION_DEPTH_EXCEEDED')
  ok('H3b 第 6 层拒绝', r === '', r ?? '')

  // ---------- H4/H5 子树随迁 ----------
  const M1 = (await mkCol('M1', 'h4-m1')).id
  const M2 = (await mkCol('M2', 'h4-m2', M1)).id
  const M3 = (await mkCol('M3', 'h4-m3', M2)).id // 子树高度 1（M2→M3）
  const C1 = (await mkCol('C1', 'h4-c1')).id
  const C2 = (await mkCol('C2', 'h4-c2', C1)).id
  const C3 = (await mkCol('C3', 'h4-c3', C2)).id
  const C4 = (await mkCol('C4', 'h4-c4', C3)).id // C 链深度 4
  r = await expectErr(`update public.collections set parent_id='${C4}' where id='${M2}'`, 'COLLECTION_DEPTH_EXCEEDED')
  ok('H4 移 M2(高1) 至 C4(深4) → 6 层拒', r === '', r ?? '')
  await q(`update public.collections set parent_id='${C3}' where id='${M2}'`) // M2 深度4，M3 深度5 → 合法
  const m3depth = (await q(`with recursive t as (select id, parent_id, 1 as d from public.collections where id='${M3}' union all select p.id, p.parent_id, t.d+1 from public.collections p join t on p.id=t.parent_id) select max(d) as depth from t`)).rows[0].depth
  ok('H5 合法深移成功且 M3 深度=5', Number(m3depth) === 5, 'depth=' + m3depth)

  // ---------- H6 删父 RESTRICT ----------
  r = await expectErr(`delete from public.collections where id='${A}'`, 'violates foreign key') // A 有子 B…d5 链
  ok('H6 删含子父级 FK RESTRICT 拒绝', r === '', r ?? '')

  // ---------- H7/H8 视图全链可见性 + 计数 ----------
  const rootPub = (await mkCol('RootPub', 'h7-rootpub', null, 'published')).id
  const childPub = (await mkCol('ChildPub', 'h7-childpub', rootPub, 'published')).id
  const draftRoot = (await mkCol('DraftRoot', 'h7-draftroot', null, 'draft')).id
  const childDraftPub = (await mkCol('ChildDraftPub', 'h7-childdraft', draftRoot, 'published')).id
  await mkPubAsset('h7-a1', rootPub)
  await mkPubAsset('h7-a2', childPub)
  await mkPubAsset('h7-a3', childPub)
  await mkPubAsset('h7-a4', childDraftPub)

  const anonRows = (await asAnon(() => q(`select id, slug, parent_id, asset_count from public.published_collections order by slug`))).rows
  const anonSlugs = anonRows.map((x) => x.slug)
  ok('H7a anon 见 rootPub+childPub', anonSlugs.includes('h7-rootpub') && anonSlugs.includes('h7-childpub'), anonSlugs.join(','))
  ok('H7b anon 不见草稿父的 published 子', !anonSlugs.includes('h7-childdraft'))
  const rp = anonRows.find((x) => x.slug === 'h7-rootpub')
  const cp = anonRows.find((x) => x.slug === 'h7-childpub')
  ok('H7c asset_count 只数直接子资产', Number(rp?.asset_count) === 1 && Number(cp?.asset_count) === 2, `root=${rp?.asset_count} child=${cp?.asset_count}`)
  ok('H7d parent_id 暴露', rp?.parent_id === null && cp?.parent_id === rootPub)

  const adminRows = (await asAdminView()).rows
  function asAdminView() {
    // admin 读视图（独立事务，ROLLBACK 丢弃）
    return (async () => {
      await q('begin')
      try {
        await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
        await q('set local role authenticated')
        return await q(`select slug from public.published_collections`)
      } finally { await q('rollback') }
    })()
  }
  ok('H8 admin 视图含 childDraftPub', adminRows.map((x) => x.slug).includes('h7-childdraft'))

  // ---------- H9 非层级更新不受守卫影响 ----------
  await q(`update public.collections set name='A-renamed' where id='${A}'`)
  const nm = (await q(`select name from public.collections where id='${A}'`)).rows[0].name
  ok('H9 普通字段更新正常', nm === 'A-renamed')

  console.log('\n===== V1.2-A FOLDER SMOKE: ' + pass + ' PASS / ' + fail + ' FAIL =====')
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  exitCode = 2
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); await mainC.end() } } catch {}
}
process.exit(exitCode)
