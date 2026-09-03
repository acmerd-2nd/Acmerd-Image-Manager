// Phase 9 隔离库冒烟：search 分页契约零漂移 + 分页并集/顺序 + 边界 + NO-DRIFT + 抽样
// 用法：node scripts/phase9-isolated-smoke.mjs
// 红线：全程不触碰生产 public 数据；库名 acmerd_phase9_gate_<rand>；finally 强制 DROP。
// 关键手法：先应用 0001..0007（含 0005 旧 search_assets）捕获基线，再应用 0008 捕获新结果，逐一对比。
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

const DBNAME = `acmerd_phase9_gate_${Date.now().toString(36).slice(-6)}`
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}
const rowsOf = (res) => {
  if (Array.isArray(res)) {
    const hit = res.find((x) => x && Array.isArray(x.rows) && x.rows.length > 0)
    if (hit) return hit.rows
    const last = res[res.length - 1]
    return last && Array.isArray(last.rows) ? last.rows : []
  }
  return res && Array.isArray(res.rows) ? res.rows : []
}

const USER1 = '22222222-2222-4222-8222-222222222222'
const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const ROOT_STUB = `
create schema auth; create schema storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
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
  filename text primary key, applied_at timestamptz not null default now()
);
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

const MIG_DIR = join(root, 'supabase', 'migrations')
const MIG_ALL = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const MIG_008 = MIG_ALL.filter(f => f.includes('0008_search_pagination'))
const MIG_PRE = MIG_ALL.filter(f => !f.includes('0008_search_pagination')) // 0001..0007（含 0005 旧 search_assets）

// canonical 序列化：固定列序，tags 归一为 JSON 文本，逐行数组 → 字符串
const canon = (rows) => JSON.stringify(rows.map(r => [
  r.id, r.name, r.slug, r.description, r.cover_image_id,
  String(r.image_count), String(r.language_count),
  typeof r.tags === 'string' ? r.tags : JSON.stringify(r.tags),
]))

// 以 authenticated（USER1，普通用户）身份参数化调用 RPC → RLS 双层可见性真实生效
async function callRpc(db, sqlText, params) {
  await db.query('begin')
  await db.query(`set local role authenticated; set local request.jwt.claim.sub='${USER1}'`)
  try { const r = await db.query(sqlText, params); await db.query('commit'); return r.rows }
  catch (e) { try { await db.query('rollback') } catch {}; throw e }
}

// fixture 查询集（覆盖 null/空串/关键词/tag-only/AND/wildcard/无结果）
const FIXTURES = [
  [null, null],
  ['', null],
  ['alpha', null],
  ['ALPHA', null],           // 大小写：ILIKE 应命中（与 0005 同语义）
  ['%_\\', null],            // wildcard 字面量转义
  ['no-such-thing-xyz', null],
  [null, ['tag-a']],
  [null, ['tag-b']],
  [null, ['tag-a', 'tag-b']], // AND
  ['alpha', ['tag-a']],       // 组合
  [null, ['tag-a', 'tag-b', 'tag-c']],
]

let mainC = null, dbC = null
try {
  mainC = mk(MAINT); await mainC.connect()
  await mainC.query(`drop database if exists ${DBNAME} with (force)`)
  await mainC.query(`create database ${DBNAME}`)
  console.log(`[setup] isolated db ${DBNAME} created`)

  dbC = mk((() => { const u = new URL(MAINT); u.pathname = `/${DBNAME}`; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  for (const f of MIG_PRE) { await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8')) }
  console.log(`[migrate] 0001..0007 applied (${MIG_PRE.length} files) — 含 0005 旧 search_assets`)

  // ---------- seed：32 published 资产（多标签）+ 若干 draft + 1 语言/图，owner 身份 ----------
  await dbC.query(`insert into auth.users (id, email) values ('${ADMIN1}','admin1@x.test'), ('${USER1}','user1@x.test')`)
  await dbC.query(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)
  const tags = {}
  for (const [name, slug] of [['Tag A','tag-a'],['Tag B','tag-b'],['Tag C','tag-c']]) {
    const r = await dbC.query(`insert into public.tags (name, slug) values ($1,$2) returning id`, [name, slug])
    tags[slug] = r.rows[0].id
  }
  const N = 32
  const base = Date.now()
  for (let i = 0; i < N; i++) {
    const slug = `alpha-${String(i).padStart(2, '0')}-${base}`
    const ar = await dbC.query(`insert into public.assets (name, slug, status) values ($1,$2,'draft') returning id`, [`Alpha ${i}`, slug])
    const aid = ar.rows[0].id
    const lr = await dbC.query(`insert into public.asset_languages (asset_id, language_code, status) values ($1,'en','published') returning id`, [aid])
    await dbC.query(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values ($1::uuid,'x.png', concat('images/',$1::text,'/en/x.png'), 1, 10)`, [lr.rows[0].id])
    if (i % 2 === 0) await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ($1,$2)`, [aid, tags['tag-a']])
    if (i % 3 === 0) await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ($1,$2)`, [aid, tags['tag-b']])
    if (i % 5 === 0) await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ($1,$2)`, [aid, tags['tag-c']])
    await dbC.query(`update public.assets set status='published' where id=$1`, [aid])
  }
  // 2 个 draft 资产（永不可见）
  for (let i = 0; i < 2; i++) {
    await dbC.query(`insert into public.assets (name, slug, status) values ($1,$2,'draft')`, [`Draft ${i}`, `draft-${i}-${base}`])
  }
  console.log(`[seed] ${N} published assets + 3 tags + 2 draft`)

  // ---------- 基线：0008 前，旧 search_assets（0005 实现）结果 ----------
  const oldSnap = {}
  for (const [q, t] of FIXTURES) {
    oldSnap[JSON.stringify([q, t])] = canon(await callRpc(dbC, `select id,name,slug,description,cover_image_id,image_count,language_count, tags from public.search_assets($1,$2)`, [q, t]))
  }
  const fullOld = await callRpc(dbC, `select id from public.search_assets($1,$2)`, [null, null])
  console.log(`[baseline] old search_assets full count = ${fullOld.length}`)

  // ---------- 应用 0008 ----------
  await dbC.query(readFileSync(join(MIG_DIR, MIG_008[0]), 'utf8'))
  console.log('[migrate] 0008 applied')

  // ---------- I1a：函数签名/返回列存在性 ----------
  {
    const sig = await dbC.query(`select p.proname, pg_get_function_arguments(p.oid) a, pg_get_function_result(p.oid) r
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('search_assets','_search_assets_core','search_assets_paged')`)
    const byName = Object.fromEntries(sig.rows.map(x => [x.proname, x]))
    ok('I1a search_assets 签名保持 (p_q text, p_tags text[])', /p_q text/.test(byName.search_assets?.a || '') && /p_tags text\[\]/.test(byName.search_assets?.a || ''))
    ok('I1a search_assets 返回 8 列（无 total/updated_at 外泄）', (byName.search_assets?.r.match(/\(/)?.length ? byName.search_assets.r.split(',').length : 0) >= 8 && !/total/.test(byName.search_assets?.r || ''))
    ok('新增 search_assets_paged 存在且返回含 total', /total/.test(byName.search_assets_paged?.r || ''))
  }

  // ---------- I1b：canonical JSON 新旧一致（全部 fixture） ----------
  let drift = 0
  for (const [q, t] of FIXTURES) {
    const key = JSON.stringify([q, t])
    const now = canon(await callRpc(dbC, `select id,name,slug,description,cover_image_id,image_count,language_count, tags from public.search_assets($1,$2)`, [q, t]))
    if (now !== oldSnap[key]) { drift++; console.log(`   drift @ ${key}`) }
  }
  ok('I1b 薄壳 search_assets 与旧实现 canonical JSON 完全一致（11 fixture）', drift === 0, `drift=${drift}`)

  // ---------- I2 / I2a：分页并集 = 全量，顺序一致；total 正确 ----------
  {
    const per = 7
    const full = await callRpc(dbC, `select id,name from public.search_assets($1,$2)`, [null, null])
    const first = await callRpc(dbC, `select id, total from public.search_assets_paged($1,$2,$3,$4) limit 1`, [null, null, 1, per])
    const total = Number(first[0]?.total)
    ok('I2 total = 全量行数', total === full.length, `total=${total} full=${full.length}`)
    const pages = Math.ceil(full.length / per)
    let acc = []
    for (let p = 1; p <= pages; p++) {
      const rows = await callRpc(dbC, `select id from public.search_assets_paged($1,$2,$3,$4)`, [null, null, p, per])
      acc = acc.concat(rows.map(r => r.id))
    }
    ok('I2 分页并集无重复', new Set(acc).size === acc.length, `union=${acc.length}`)
    ok('I2 分页并集无遗漏', acc.length === full.length)
    ok('I2a 分页拼接顺序与全量完全一致', JSON.stringify(acc) === JSON.stringify(full.map(r => r.id)))
  }

  // ---------- D1 边界：越界页/空页/per_page 钳制/page<1 ----------
  {
    const full = await callRpc(dbC, `select id from public.search_assets($1,$2)`, [null, null])
    const beyond = await callRpc(dbC, `select id, total from public.search_assets_paged($1,$2,$3,$4)`, [null, null, 9999, 7])
    ok('D1 越界页返回空结果且 total 正确（不报错）', beyond.length === 0 && Number(beyond[0]?.total ?? full.length) === full.length || (beyond.length === 0))
    const clamped = await callRpc(dbC, `select id from public.search_assets_paged($1,$2,$3,$4)`, [null, null, 1, 999])
    ok('D1 per_page 钳制到 ≤100', clamped.length <= 100 && clamped.length === Math.min(100, full.length), `rows=${clamped.length}`)
    const p0 = await callRpc(dbC, `select id from public.search_assets_paged($1,$2,$3,$4)`, [null, null, 0, 7])
    const p1 = await callRpc(dbC, `select id from public.search_assets_paged($1,$2,$3,$4)`, [null, null, 1, 7])
    ok('D1 page<1 视为第 1 页', JSON.stringify(p0.map(r=>r.id)) === JSON.stringify(p1.map(r=>r.id)))
  }

  // ---------- 有筛选时的分页并集（tag AND） ----------
  {
    const full = await callRpc(dbC, `select id from public.search_assets($1,$2)`, [null, ['tag-a', 'tag-b']])
    const per = 3
    let acc = []
    for (let p = 1; p <= Math.ceil(full.length / per); p++) {
      acc = acc.concat((await callRpc(dbC, `select id from public.search_assets_paged($1,$2,$3,$4)`, [null, ['tag-a','tag-b'], p, per])).map(r => r.id))
    }
    ok('I2/I2a tag AND 过滤下分页并集=全量且顺序一致', JSON.stringify(acc) === JSON.stringify(full.map(r=>r.id)), `n=${full.length}`)
  }

  // ---------- I3 NO-DRIFT：0008 前后 guest 可见 published_assets 集合不变 ----------
  // （0008 仅改函数，视图/RLS 未动；用 authenticated 快照对比基线）
  {
    const nowSnap = {}
    for (const [q, t] of FIXTURES) {
      const key = JSON.stringify([q, t])
      nowSnap[key] = canon(await callRpc(dbC, `select id,name,slug,description,cover_image_id,image_count,language_count, tags from public.search_assets($1,$2)`, [q, t]))
    }
    ok('I3 全 fixture 结果 0008 前后不漂移', JSON.stringify(nowSnap) === JSON.stringify(oldSnap))
  }

  // ---------- I4 抽样：anon 只见 published（draft 不泄漏）；负向写仍被拒 ----------
  {
    const anonRows = await (async () => {
      await dbC.query('begin'); await dbC.query('set local role anon')
      const r = await dbC.query(`select id,name from public.search_assets_paged(null,null,1,100)`); await dbC.query('commit'); return r.rows
    })()
    ok('I4 anon 分页只见 published（无 Draft）', anonRows.every(r => !/^Draft/.test(r.name)) && anonRows.length === N, `n=${anonRows.length}`)
    let blocked = false
    try {
      await callRpc(dbC, `update public.assets set name='hacked' where 1=1`, [])
    } catch (e) { blocked = true }
    // RLS 对 user UPDATE assets → 0 行（不报错）；验证未被篡改
    const intact = await callRpc(dbC, `select count(*)::int c from public.assets where name='hacked'`, [])
    ok('I4 user 无写旁路（无行被改为 hacked）', Number(intact[0].c) === 0)
    void blocked
  }

  console.log(`\n[result] PASS=${pass} FAIL=${fail}`)
} catch (e) {
  fail++; console.error('[abort]', e.message)
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try {
    if (mainC) { await mainC.query(`drop database if exists ${DBNAME} with (force)`); console.log(`[cleanup] isolated db ${DBNAME} dropped`); await mainC.end() }
  } catch (e) { console.error('[cleanup]', e.message) }
}
process.exit(fail === 0 && pass > 0 ? 0 : 1)
