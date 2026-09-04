#!/usr/bin/env node
// Phase 10 · R3 Asset / R4 Language 生命周期 + I1–I4 发布复验（L-A 隔离库）
// 用法：node scripts/phase10-isolated-regression.mjs
// 红线：一次性库 acmerd_phase10_reg_<rand>，finally DROP；不触碰生产数据；
//       R3/R4 以真实 RLS 身份写（authenticated + jwt claim），守卫异常 = FAIL-EXPECTED 语义。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const MAINT = process.env.DATABASE_URL
if (!MAINT) { console.error('DATABASE_URL is not set'); process.exit(2) }

const DBNAME = `acmerd_phase10_reg_${Date.now().toString(36).slice(-6)}`
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}
const rowsOf = (res) => (Array.isArray(res) ? (res.find(x => x?.rows?.length) ?? res[res.length - 1])?.rows ?? [] : res?.rows ?? [])

const USER1 = '22222222-2222-4222-8222-222222222222'
const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const ROOT_STUB = `
create schema auth; create schema storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
create table storage.buckets (id text primary key, name text not null,
  public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id), name text not null, owner_id uuid,
  created_at timestamptz not null default now());
alter table storage.objects enable row level security;
grant usage on schema public, storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated, service_role;
create table if not exists public.schema_migrations (filename text primary key, applied_at timestamptz not null default now());
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`
const MIG_DIR = join(root, 'supabase', 'migrations')
const MIG_ALL = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const MIG_008 = MIG_ALL.filter(f => f.includes('0008_search_pagination'))
const MIG_PRE = MIG_ALL.filter(f => !f.includes('0008_search_pagination'))

const asUser = (db, sub) => async (sql, params = []) => {
  await db.query('begin')
  await db.query(`set local role authenticated; set local request.jwt.claim.sub='${sub}'`)
  try { const r = await db.query(sql, params); await db.query('commit'); return r }
  catch (e) { try { await db.query('rollback') } catch {}; throw e }
}
const asAnon = (db) => async (sql, params = []) => {
  await db.query('begin'); await db.query('set local role anon')
  try { const r = await db.query(sql, params); await db.query('commit'); return r }
  catch (e) { try { await db.query('rollback') } catch {}; throw e }
}
const expectErr = async (fn, needle) => {
  try { await fn(); return false } catch (e) { return needle ? String(e.message).includes(needle) : true }
}
const canon = (rows) => JSON.stringify(rows.map(r => [
  r.id, r.name, r.slug, r.description, r.cover_image_id,
  String(r.image_count), String(r.language_count),
  typeof r.tags === 'string' ? r.tags : JSON.stringify(r.tags),
]))
const FIXTURES = [[null, null], ['alpha', null], ['%_\\', null], [null, ['tag-a']], [null, ['tag-a', 'tag-b']], ['alpha', ['tag-a']]]

let mainC = null, dbC = null
try {
  mainC = mk(MAINT); await mainC.connect()
  await mainC.query(`drop database if exists ${DBNAME} with (force)`)
  await mainC.query(`create database ${DBNAME}`)
  console.log(`[setup] isolated db ${DBNAME} created`)
  dbC = mk((() => { const u = new URL(MAINT); u.pathname = `/${DBNAME}`; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  for (const f of MIG_PRE) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  console.log(`[migrate] 0001..0007 applied (${MIG_PRE.length} files)`)

  const admin = asUser(dbC, ADMIN1), user = asUser(dbC, USER1), anon = asAnon(dbC)

  // ---------- seed ----------
  await dbC.query(`insert into auth.users (id, email) values ('${ADMIN1}','admin1@x.test'), ('${USER1}','user1@x.test')`)
  await dbC.query(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)
  const t = {}
  for (const [n, s] of [['Tag A', 'tag-a'], ['Tag B', 'tag-b']]) {
    const r = await dbC.query(`insert into public.tags (name, slug) values ($1,$2) returning id`, [n, s]); t[s] = r.rows[0].id
  }
  const base = Date.now()
  for (let i = 0; i < 8; i++) {
    const ar = await dbC.query(`insert into public.assets (name, slug) values ($1,$2) returning id`, [`Alpha ${i}`, `alpha-${i}-${base}`])
    const aid = ar.rows[0].id
    const lr = await dbC.query(`insert into public.asset_languages (asset_id, language_code, status) values ($1,'en','published') returning id`, [aid])
    await dbC.query(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,'x.png', concat('images/',$1::text,'/en/x.png'), 1, 10)`, [lr.rows[0].id])
    if (i % 2 === 0) await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ($1,$2)`, [aid, t['tag-a']])
    if (i % 3 === 0) await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ($1,$2)`, [aid, t['tag-b']])
    await dbC.query(`update public.assets set status='published' where id=$1`, [aid])
  }
  console.log('[seed] 8 published assets + 2 tags（供 I1–I4 基线）')

  // ---------- 旧 search_assets 基线（占位：在应用 0008 前一刻采集，保证生命周期变更后仍零漂移可比） ----------
  const oldSnap = {}
  for (const [q, tg] of FIXTURES) oldSnap[JSON.stringify([q, tg])] = canon((await admin(`select id,name,slug,description,cover_image_id,image_count,language_count,tags from public.search_assets($1,$2)`, [q, tg])).rows)

  // ========== R3 Asset 生命周期（admin 真实 RLS 身份） ==========
  console.log('\n--- R3 Asset Regression（Create/Edit/Publish/Archive/Delete/Cover）---')
  const aid = ((await admin(`insert into public.assets (name, slug, description) values ($1,$2,$3) returning id`, ['R3 Asset', `r3-asset-${base}`, 'lifecycle'])).rows)[0].id
  ok('R3-1 Create：admin 插入 draft asset', !!aid)
  await admin(`update public.assets set name=$2, description=$3 where id=$1`, [aid, 'R3 Asset v2', 'lifecycle-edited'])
  const nm = ((await admin(`select name, description from public.assets where id=$1`, [aid])).rows)[0]
  ok('R3-2 Edit：name/description 更新并回读一致', nm.name === 'R3 Asset v2' && nm.description === 'lifecycle-edited')

  const langEn = ((await admin(`insert into public.asset_languages (asset_id, language_code, status) values ($1,'en','draft') returning id`, [aid])).rows)[0].id
  const imgEn = ((await admin(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,'a.png', concat('images/',$1::text,'/en/a.png'), 1, 10) returning id`, [langEn])).rows)[0].id
  let blocked = await expectErr(() => admin(`update public.assets set status='published' where id=$1`, [aid]), 'PUBLISH_BLOCKED')
  ok('R3-3 Publish 终守卫：无 published 语言+图 → PUBLISH_BLOCKED', blocked)
  await admin(`update public.asset_languages set status='published' where id=$1`, [langEn])
  await admin(`update public.assets set status='published' where id=$1`, [aid])
  ok('R3-4 Publish：语言 published+有图后发布成功', ((await admin(`select status from public.assets where id=$1`, [aid])).rows)[0].status === 'published')

  const aid2 = ((await admin(`insert into public.assets (name, slug) values ($1,$2) returning id`, ['R3 Other', `r3-other-${base}`])).rows)[0].id
  const langEn2 = ((await admin(`insert into public.asset_languages (asset_id, language_code, status) values ($1,'en','published') returning id`, [aid2])).rows)[0].id
  const imgEn2 = ((await admin(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,'b.png', concat('images/',$1::text,'/en/b.png'), 1, 10) returning id`, [langEn2])).rows)[0].id
  blocked = await expectErr(() => admin(`update public.assets set cover_image_id=$2 where id=$1`, [aid, imgEn2]), 'COVER_MISMATCH')
  ok('R3-5 Cover 守卫：跨资产 cover → COVER_MISMATCH', blocked)
  await admin(`update public.assets set cover_image_id=$2 where id=$1`, [aid, imgEn])
  ok('R3-6 Cover：同资产图设为封面成功', ((await admin(`select cover_image_id from public.assets where id=$1`, [aid])).rows)[0].cover_image_id === imgEn)

  await admin(`update public.assets set status='draft' where id=$1`, [aid])
  ok('R3-7 Unpublish：published→draft，guest 不可见', ((await anon(`select count(*)::int c from public.published_assets where id=$1`, [aid])).rows)[0].c === 0)
  await admin(`update public.assets set status='archived' where id=$1`, [aid])
  ok('R3-8 Archive：archived 后 guest 不可见', ((await anon(`select count(*)::int c from public.published_assets where id=$1`, [aid])).rows)[0].c === 0)
  await admin(`update public.assets set status='draft' where id=$1`, [aid])
  ok('R3-9 Restore（archived→draft）：guest 仍不可见（draft 态）', ((await anon(`select count(*)::int c from public.published_assets where id=$1`, [aid])).rows)[0].c === 0)
  await admin(`update public.assets set status='published' where id=$1`, [aid])
  ok('R3-9b 重新发布后恢复可见', ((await anon(`select count(*)::int c from public.published_assets where id=$1`, [aid])).rows)[0].c === 1)

  const auditActs = ((await dbC.query(`select distinct action from public.audit_logs where action like 'asset.%' order by 1`)).rows).map(x => x.action)
  ok('R3-10 状态化审计：published/unpublished/archived/restored 四语义全留痕（allowlist 内）',
    ['asset.published', 'asset.unpublished', 'asset.archived', 'asset.restored'].every(a => auditActs.includes(a)), auditActs.join(','))

  // user 无资产写旁路（R6 等价性抽样，L-A 内复证）
  await user(`update public.assets set name='hacked' where id=$1`, [aid])
  ok('R3-11 user UPDATE assets → 0 行旁路（回读未变）', ((await admin(`select name from public.assets where id=$1`, [aid])).rows)[0].name !== 'hacked')

  // ---------- R4 Language 生命周期 ----------
  console.log('\n--- R4 Language Regression（EN/DE/IT/FR/ES × Draft/Published/Switch）---')
  const lc = ((await admin(`insert into public.assets (name, slug) values ($1,$2) returning id`, ['R4 Lang', `r4-lang-${base}`])).rows)[0].id
  const ins = (code, st) => admin(`insert into public.asset_languages (asset_id, language_code, status) values ($1,$2,$3) returning id`, [lc, code, st])
  const langIds = {}
  for (const code of ['en', 'de', 'it', 'fr', 'es']) langIds[code] = (await ins(code, code === 'en' ? 'published' : 'draft')).rows[0].id
  for (const code of ['de', 'it', 'fr', 'es']) await admin(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,concat($2::text,'.png'), concat('images/',$1::text,'/',$2::text,'/x.png'), 1, 10)`, [langIds[code], code])
  await admin(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,'en.png', concat('images/',$1::text,'/en/x.png'), 1, 10)`, [langIds['en']])
  ok('R4-1 五语言 en/de/it/fr/es 全部可创建（CHECK 通过）', Object.keys(langIds).length === 5)
  ok('R4-2 非法语言码 zh → CHECK 拒绝', await expectErr(() => admin(`insert into public.asset_languages (asset_id, language_code, status) values ($1,'zh','draft')`, [lc])))
  ok('R4-3 同资产同语言重复 → unique 拒绝', await expectErr(() => ins('en', 'draft')))
  await admin(`update public.assets set status='published' where id=$1`, [lc])
  let cnt = () => admin(`select language_count::int, image_count::int from public.published_assets where id=$1`, [lc])
  ok('R4-4 双层可见性：asset published + 仅 en published → language_count=1', ((await cnt()).rows)[0].language_count === 1)
  for (const code of ['de', 'it']) await admin(`update public.asset_languages set status='published' where id=$1`, [langIds[code]])
  ok('R4-5 Switch：de/it 相继 published → language_count=3', ((await cnt()).rows)[0].language_count === 3)
  await admin(`update public.asset_languages set status='draft' where id=$1`, [langIds['de']])
  ok('R4-6 Unpublish：de 回 draft → language_count=2', ((await cnt()).rows)[0].language_count === 2)
  ok('R4-7 draft 语言下的图不计入 guest 可见面（image_count 只算 published 语言：en+it 各 1 图）', ((await cnt()).rows)[0].image_count === 2, `image_count=${((await cnt()).rows)[0].image_count}`)
  const langAudit = ((await dbC.query(`select distinct action from public.audit_logs where action like 'asset_language.%' order by 1`)).rows).map(x => x.action)
  ok('R4-8 语言审计（0007 五语义）：created/published/unpublished 留痕', ['asset_language.created', 'asset_language.published', 'asset_language.unpublished'].every(a => langAudit.includes(a)), langAudit.join(','))
  ok('R4-9 user 写 asset_languages → 0 行旁路', await (async () => { await user(`update public.asset_languages set status='published' where asset_id=$1`, [aid2]); const r = await admin(`select count(*)::int c from public.asset_languages where asset_id=$1 and status='published'`, [aid2]); return r.rows[0].c === 1 })())

  // ---------- R3-12 Delete + 级联 ----------
  await admin(`delete from public.assets where id=$1`, [aid2])
  const leftover = ((await dbC.query(`select
    (select count(*)::int from public.asset_languages where asset_id=$1) l,
    (select count(*)::int from public.images i join public.asset_languages al on i.asset_language_id=al.id where al.asset_id=$1) im`, [aid2])).rows)[0]
  ok('R3-12 Delete：asset 删除后语言/图级联清零', leftover.l === 0 && leftover.im === 0, `langs=${leftover.l} images=${leftover.im}`)

  // ---------- 应用 0008 → I1–I4 发布复验 ----------
  // 基线在 0008 前一刻采集（此时 R3/R4 生命周期变更已全部落库，保证 NO-DRIFT 只度量 0008 本身）
  for (const [q, tg] of FIXTURES) oldSnap[JSON.stringify([q, tg])] = canon((await admin(`select id,name,slug,description,cover_image_id,image_count,language_count,tags from public.search_assets($1,$2)`, [q, tg])).rows)
  const pubCountBefore = ((await admin(`select count(*)::int c from public.published_assets`, [])).rows)[0].c
  await dbC.query(readFileSync(join(MIG_DIR, MIG_008[0]), 'utf8'))
  console.log('\n[migrate] 0008 applied — I1–I4 复验')
  const sig = ((await dbC.query(`select proname, pg_get_function_arguments(p.oid) a, pg_get_function_result(p.oid) r from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('search_assets','search_assets_paged')`)).rows)
  const byName = Object.fromEntries(sig.map(x => [x.proname, x]))
  ok('I1a search_assets 签名保持 (p_q, p_tags)', /p_q text/.test(byName.search_assets?.a || '') && /p_tags text\[\]/.test(byName.search_assets?.a || ''))
  ok('I1a search_assets_paged 含 total', /total/.test(byName.search_assets_paged?.r || ''))
  let drift = 0
  for (const [q, tg] of FIXTURES) {
    const now = canon((await admin(`select id,name,slug,description,cover_image_id,image_count,language_count,tags from public.search_assets($1,$2)`, [q, tg])).rows)
    if (now !== oldSnap[JSON.stringify([q, tg])]) drift++
  }
  ok('I1b/I3 search 结果 0008 前后 canonical 一致（NO-DRIFT，6 fixture）', drift === 0, `drift=${drift}`)
  const full = ((await admin(`select id from public.search_assets($1,$2)`, [null, null])).rows)
  const per = 3
  let acc = []
  for (let p = 1; p <= Math.ceil(full.length / per); p++) acc = acc.concat((await admin(`select id from public.search_assets_paged($1,$2,$3,$4)`, [null, null, p, per])).rows.map(r => r.id))
  ok('I2 分页并集=全量、无重复', new Set(acc).size === acc.length && acc.length === full.length, `union=${acc.length} full=${full.length}`)
  ok('I2a 分页拼接顺序与全量一致', JSON.stringify(acc) === JSON.stringify(full.map(r => r.id)))
  const anonRows = (await anon(`select id, name from public.search_assets_paged(null,null,1,100)`)).rows
  ok('I4 anon 只见 published（数量=admin 视角 published 数，无 draft 泄漏）', anonRows.length === pubCountBefore && anonRows.every(r => !/^(Draft )/.test(r.name)), `n=${anonRows.length} pub=${pubCountBefore}`)

  console.log(`\n[result] PASS=${pass} FAIL=${fail}`)
} catch (e) {
  fail++; console.error('[abort]', e.message)
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query(`drop database if exists ${DBNAME} with (force)`); console.log(`[cleanup] isolated db ${DBNAME} dropped`); await mainC.end() } } catch (e) { console.error('[cleanup]', e.message) }
}
process.exit(fail === 0 && pass > 0 ? 0 : 1)
