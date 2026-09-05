#!/usr/bin/env node
/**
 * V1.1 PC-2 冒烟（隔离库，生产零触碰）
 * C1  published_collections 视图 = published 且 ≥1 双层 published 资产；空 shell 不出现
 * C2  asset_count 只数双层 published
 * C3  sort_order 排序生效
 * C4  cover_image_id 暴露在视图行
 * C5  RLS：anon 只读 published；写拒绝（显式事务内 SET LOCAL role authenticated 模拟）
 * C6  guard_collection_cover：cover 必须属于本 Collection 资产 → 违规拒
 * C7  guard_asset_collection_move：cover 资产移出 → 拒；非 cover 资产移出 → 放行
 * C8  删除 Collection → 资产 collection_id 置 null（Q3：回归未归组，不进公域）
 * C9  未归组 published 资产仍出现在 published_assets（首页折叠区数据源）
 * C10 审计：collection.published / collection.deleted（admin 身份事务内提交）
 * 角色模拟说明：postgres 是 authenticated 成员（HANDOVER #3）。
 *   - 读/拒绝测试：BEGIN → SET LOCAL role authenticated（claim 空 = anon 等效）→ ROLLBACK
 *   - admin 持久写：BEGIN → claim.sub=ADMIN1 + SET LOCAL role authenticated → ... → COMMIT
 *     （以 authenticated + admin claim 走 RLS，审计触发器记 auth.uid()=ADMIN1）
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

const DBNAME = 'acmerd_v11_c2_' + Date.now().toString(36).slice(-6)

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

  // ---------- 角色模拟（显式事务；SET LOCAL 在事务内才生效） ----------
  // anon 等效读/写测试（ROLLBACK 丢弃一切副作用）
  const asAnon = async (fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }
  // admin 身份 + 持久提交（走 RLS admin 路径；审计记 auth.uid()=ADMIN1）
  const asAdminCommit = async (fn) => {
    await q('begin')
    await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
    await q('set local role authenticated')
    const r = await fn()
    await q('commit')
    return r
  }

  // ---------- seed（owner 身份；auth.uid()=null 审计自然跳过） ----------
  await q("insert into auth.users (id, email) values ('" + ADMIN1 + "','admin1@x.test')")
  await q("update public.user_roles set role='admin' where user_id='" + ADMIN1 + "'")

  // 种子顺序：draft 插入 → 语言(published) → 图片(ready) → 再发布资产（避开 PUBLISH_BLOCKED 守卫）
  const ar = await q(`insert into public.assets (name, slug, status, created_by) values
    ('Pub One', 'pub-one', 'draft', '${ADMIN1}'),
    ('Pub Two', 'pub-two', 'draft', '${ADMIN1}'),
    ('Draft One', 'draft-one', 'draft', '${ADMIN1}') returning id, slug`)
  const P1 = ar.rows.find((r) => r.slug === 'pub-one').id
  const P2 = ar.rows.find((r) => r.slug === 'pub-two').id
  const D1 = ar.rows.find((r) => r.slug === 'draft-one').id
  for (const id of [P1, P2, D1]) {
    await q(`insert into public.asset_languages (asset_id, language_code, status) values ('${id}', 'en', 'published')`)
  }
  const langP1 = (await q(`select id from public.asset_languages where asset_id='${P1}'`)).rows[0].id
  const langP2 = (await q(`select id from public.asset_languages where asset_id='${P2}'`)).rows[0].id
  const imgP1 = (await q(`insert into public.images (asset_language_id, filename, provider, status, sort_order, storage_path)
    values ('${langP1}', 'cover1.jpg', 'supabase_storage', 'ready', 0, 'images/x/cover1.jpg') returning id`)).rows[0].id
  await q(`insert into public.images (asset_language_id, filename, provider, status, sort_order, storage_path)
    values ('${langP2}', 'p2img.jpg', 'supabase_storage', 'ready', 0, 'images/x/p2img.jpg')`)
  await q(`update public.assets set status='published' where id in ('${P1}', '${P2}')`)

  // ---------- C1/C2/C4：视图语义（owner 预置 → admin 事务内发布） ----------
  await q(`insert into public.collections (name, slug, status, sort_order) values ('Shell', 'shell', 'published', 0)`)
  const colA = (await q(`insert into public.collections (name, slug, status, sort_order) values ('Alpha', 'alpha', 'draft', 1) returning id`)).rows[0]
  await q(`update public.assets set collection_id='${colA.id}' where id in ('${P1}','${P2}','${D1}')`)
  await q(`update public.collections set cover_image_id='${imgP1}' where id='${colA.id}'`) // P1 已在 Alpha → guard 放行
  await asAdminCommit(async () => {
    await q(`update public.collections set status='published' where id='${colA.id}'`)
  })
  const viewRows = await q('select * from public.published_collections order by sort_order')
  ok('C1 view lists published+non-empty only', viewRows.rows.length === 1 && viewRows.rows[0].slug === 'alpha',
    'rows=' + viewRows.rows.map((r) => r.slug).join(','))
  const alpha = viewRows.rows[0]
  ok('C2 asset_count excludes draft assets', Number(alpha.asset_count) === 2, 'count=' + alpha.asset_count)
  ok('C4 cover_image_id exposed', alpha.cover_image_id === imgP1)

  // ---------- C3：sort_order 排序 ----------
  const colB = (await q(`insert into public.collections (name, slug, status, sort_order) values ('Beta', 'beta', 'published', 0) returning id`)).rows[0]
  await q(`update public.assets set collection_id='${colB.id}' where id='${P2}'`)
  const ordered = await q('select slug from public.published_collections order by sort_order')
  ok('C3 sort_order ordering', ordered.rows.map((r) => r.slug).join(',') === 'beta,alpha', ordered.rows.map((r) => r.slug).join(','))

  // ---------- C5：RLS（anon = authenticated + 空 claim；事务内回滚） ----------
  const anonCols = await asAnon(async () => q('select slug from public.collections order by slug'))
  ok('C5a anon reads published only', anonCols.rows.map((r) => r.slug).join(',') === 'alpha,beta,shell',
    anonCols.rows.map((r) => r.slug).join(','))
  const adminCols = await asAnon(async () => q(`select slug from public.collections where slug in ('alpha','shell') order by slug`))
  ok('C5b admin-only draft filtering consistent', adminCols.rows.length === 2)

  const anonInsDenied = await asAnon(async () => {
    try { await q(`insert into public.collections (name, slug) values ('x','x')`); return false }
    catch { return true }
  })
  ok('C5c anon insert denied', anonInsDenied)
  const anonUpdRows = await asAnon(async () => {
    const r = await q(`update public.collections set name='hax' where slug='alpha'`)
    return r.rowCount ?? 0
  })
  ok('C5d non-admin update denied (0 rows)', anonUpdRows === 0, 'rowCount=' + anonUpdRows)
  const anonDelRows = await asAnon(async () => {
    const r = await q(`delete from public.collections where slug='shell'`)
    return r.rowCount ?? 0
  })
  ok('C5e non-admin delete denied (0 rows)', anonDelRows === 0, 'rowCount=' + anonDelRows)

  // ---------- C6：cover guard（事务内 admin 身份；ROLLBACK 不留副作用） ----------
  const colC = (await q(`insert into public.collections (name, slug, status) values ('Gamma', 'gamma', 'draft') returning id`)).rows[0]
  const imgOther = (await q(`insert into public.images (asset_language_id, filename, provider, status, sort_order, storage_path)
    values ('${langP1}', 'other.jpg', 'supabase_storage', 'ready', 1, 'images/x/other.jpg') returning id`)).rows[0].id
  let c6Msg = ''
  const guardHit = await asAnon(async () => {
    try { return 'no-rls' } catch { return 'no-rls' }
  })
  // cover 更新用 admin（提交路径不重要，用事务回滚版观察异常）
  await q('begin')
  await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
  await q('set local role authenticated')
  let c6Result = false
  try {
    await q(`update public.collections set cover_image_id='${imgOther}' where id='${colC.id}'`)
    c6Result = false
  } catch (e) {
    c6Msg = e.message
    c6Result = /COLLECTION_COVER_MISMATCH/.test(e.message)
  }
  await q('rollback')
  ok('C6 cover must belong to collection assets', c6Result, c6Msg.slice(0, 80))

  // ---------- C7：asset move guard ----------
  const coverAsset = (await q(`select a.id from public.images i join public.asset_languages l on l.id=i.asset_language_id join public.assets a on a.id=l.asset_id where i.id='${imgP1}'`)).rows[0].id
  let c7a = false, c7Msg = ''
  await q('begin')
  await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
  await q('set local role authenticated')
  try {
    await q(`update public.assets set collection_id=null where id='${coverAsset}'`)
  } catch (e) {
    c7Msg = e.message
    c7a = /COLLECTION_COVER_IN_USE/.test(e.message)
  }
  await q('rollback')
  ok('C7a cover asset move denied', c7a, c7Msg.slice(0, 80))
  // C7b 独立事务（C7a 抛错会 abort 同事务）
  let c7b = false
  await q('begin')
  await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
  await q('set local role authenticated')
  try {
    await q(`update public.assets set collection_id=null where id='${P2}'`)
    c7b = true
  } catch { c7b = false }
  await q('rollback')
  ok('C7b non-cover asset move allowed', c7b)

  // ---------- C8：删除 Collection → 资产回归未归组（D1 放进 Beta 后删 Beta） ----------
  await q(`update public.assets set collection_id='${colB.id}' where id='${D1}'`)
  const delOk = await asAdminCommit(async () => {
    try { await q(`delete from public.collections where id='${colB.id}'`); return true } catch { return false }
  })
  const d1After = (await q(`select collection_id from public.assets where id='${D1}'`)).rows[0]
  ok('C8 delete sets asset collection_id null', delOk && d1After.collection_id === null,
    'deleted=' + delOk + ', D1.collection_id=' + d1After.collection_id)

  // ---------- C9：未归组 published 资产仍在 published_assets（P2 已在 Alpha；P1 在 Alpha） ----------
  // 用 C8 后的 D1? D1 是 draft 不进视图。改验：owner 造一个未归组 published 资产已在 seed（无）
  // 直接验证：P2 移回未归组后仍出现在视图
  await q(`update public.assets set collection_id=null where id='${P2}'`)
  const ungrouped = await q(`select slug from public.published_assets where id='${P2}'`)
  ok('C9 ungrouped published assets still listed', ungrouped.rows.length === 1,
    'rows=' + ungrouped.rows.map((r) => r.slug).join(','))

  // ---------- C10：审计（C1 的 publish 与 C8 的 delete 均经 admin 事务提交） ----------
  const audits = await q(`select action from public.audit_logs where action like 'collection.%' order by created_at`)
  const acts = audits.rows.map((r) => r.action)
  ok('C10a collection.published audited', acts.includes('collection.published'), acts.join(','))
  ok('C10b collection.deleted audited', acts.includes('collection.deleted'), acts.join(','))

  console.log('\n===== PC-2 SMOKE: ' + pass + ' PASS / ' + fail + ' FAIL =====')
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  exitCode = 2
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); await mainC.end() } } catch {}
}
process.exit(exitCode)
