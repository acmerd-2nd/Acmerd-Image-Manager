// Phase 8 隔离库冒烟 + 公开集合不漂移回归（一次性库，跑完自动 DROP）
// 用法：node scripts/phase8-isolated-smoke.mjs
// 依赖 .env 中 DATABASE_URL（直连生产 PG 的 postgres 库，postgres 角色需 rolcreatedb）
// 红线：全程不触碰生产 public 数据；库名 acmerd_phase8_gate_<rand>；finally 强制清理。
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

const DBNAME = `acmerd_phase8_gate_${Date.now().toString(36).slice(-6)}`
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// 多语句 simple-protocol 消息会返回 Result[]；此处统一取出首个有行的 Result，无行取最后 Result
const rowsOf = (res) => {
  if (Array.isArray(res)) {
    const hit = res.find((x) => x && Array.isArray(x.rows) && x.rows.length > 0)
    if (hit) return hit.rows
    const last = res[res.length - 1]
    return last && Array.isArray(last.rows) ? last.rows : []
  }
  return res && Array.isArray(res.rows) ? res.rows : []
}

const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const USER1  = '22222222-2222-4222-8222-222222222222'
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
-- db-apply 执行器在应用迁移前会创建 schema_migrations；隔离库同步创建，供 0002 REVOKE 引用
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

const MIG_DIR = join(root, 'supabase', 'migrations')
const MIG_ALL = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const MIG_007 = MIG_ALL.filter(f => f.includes('0007_audit_hardening'))
const MIG_PRE = MIG_ALL.filter(f => !f.includes('0007_audit_hardening'))

let mainC = null, dbC = null
try {
  mainC = mk(MAINT); await mainC.connect()
  await mainC.query(`drop database if exists ${DBNAME} with (force)`)
  await mainC.query(`create database ${DBNAME}`)
  console.log(`[setup] isolated db ${DBNAME} created`)

  dbC = mk((() => { const u = new URL(MAINT); u.pathname = `/${DBNAME}`; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  console.log('[setup] supabase stub (auth/storage/default-privileges) ready')

  for (const f of MIG_PRE) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8')
    await dbC.query(sql)
    console.log(`[migrate] ${f} OK`)
  }
  console.log(`[migrate] 0001..0006 applied (${MIG_PRE.length} files)`)

  // ---------- seed（root 身份，owner 绕过 RLS；审计触发器对 auth.uid()=null 自然跳过） ----------
  await dbC.query(`insert into auth.users (id, email) values ('${ADMIN1}','admin1@x.test'), ('${USER1}','user1@x.test')`)
  await dbC.query(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)
  // asset P（目标 published：en 语言 published + 2 图，de 语言 draft + 1 图）；asset D = draft。
  // 注意 0003 guard_asset_publish：资产须先 draft 插入，语言/图片就绪后再提升 published。
  const ares = await dbC.query(`insert into public.assets (name, slug, status, created_by) values
    ('Published Asset', 'published-asset', 'draft', '${ADMIN1}'),
    ('Draft Asset', 'draft-asset', 'draft', '${ADMIN1}')
    returning id, slug`)
  const pId = ares.rows.find(r => r.slug === 'published-asset').id
  const lang_en = (await dbC.query(`insert into public.asset_languages (asset_id, language_code, status)
    values ('${pId}', 'en', 'published') returning id`)).rows[0].id
  const lang_de = (await dbC.query(`insert into public.asset_languages (asset_id, language_code, status)
    values ('${pId}', 'de', 'draft') returning id`)).rows[0].id
  await dbC.query(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values
    ('${lang_en}', 'a.png', 'published-asset/en/a.png', 1, 100),
    ('${lang_en}', 'b.png', 'published-asset/en/b.png', 2, 200),
    ('${lang_de}', 'c.png', 'published-asset/de/c.png', 1, 300)`)
  const tag_id = (await dbC.query(`insert into public.tags (name, slug) values ('Original Tag', 'original-tag') returning id`)).rows[0].id
  await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ('${pId}', '${tag_id}')`)
  await dbC.query(`update public.assets set status='published' where id='${pId}'`)
  console.log('[seed] fixture ready: asset_p=' + pId + ' lang_en=' + lang_en + ' lang_de=' + lang_de + ' tag=' + tag_id)

  // DEF-1 pre-proof: 0007 前 tags UPDATE 必须报 record "new" has no field "updated_at"
  {
    try {
      await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}';
        update public.tags set name='Renamed Pre' where id='${tag_id}'; commit`)
      ok('DEF-1 pre(0007): tags UPDATE 被既有 touch trigger 阻断（期望报错）', false, '意外成功')
    } catch (e) {
      ok('DEF-1 pre(0007): tags UPDATE 被既有 touch trigger 阻断', /updated_at|updated_at.*field|no field/i.test(e.message), e.message.slice(0, 90))
    }
    try { await dbC.query('rollback') } catch {}
  }

  // ---------- Snapshot A（Guest 视角，authenticated 无 JWT，0007 前） ----------
  const SNAP_QUERIES = [
    `select id, name, slug, image_count, language_count, tags::text as tags from public.published_assets order by id`,
    `select count(*)::int c from public.assets a join public.asset_languages l on l.asset_id=a.id where a.status='published' and l.status='published'`,
    `select count(*)::int c from public.images i join public.asset_languages l on i.asset_language_id=l.id join public.assets a on l.asset_id=a.id where a.status='published' and l.status='published'`,
    `select count(*)::int c from public.asset_tags at_ join public.assets a on a.id=at_.asset_id where a.status='published'`,
  ]
  async function snapshot() {
    const out = []
    for (let qi = 0; qi < SNAP_QUERIES.length; qi++) {
      const q = SNAP_QUERIES[qi]
      try {
        await dbC.query('begin'); await dbC.query('set local role authenticated')
        const r = await dbC.query(q)
        out.push(JSON.stringify(r.rows)); await dbC.query('commit')
      } catch (e) {
        try { await dbC.query('rollback') } catch (_) {}
        throw new Error(`SNAP_QUERY#${qi + 1} FAILED: ` + e.message)
      }
    }
    return out.join('\n')
  }
  const snapA = await snapshot()

  // ---------- 应用 0007 后再快照 ----------
  await dbC.query(readFileSync(join(MIG_DIR, MIG_007[0]), 'utf8'))
  console.log('[migrate] 0007 applied (2nd time, after snapshot A)')
  const snapB = await snapshot()
  ok('NO-DRIFT: Guest 视角公开数据集合 0007 前后逐字节一致', snapA === snapB,
     snapA === snapB ? `4 组快照相同` : 'DRIFT DETECTED')

  // ---------- 触发器语义用例（admin1 身份，RLS 真实生效） ----------
  const asAdmin = async (sql, label) => {
    try {
      const r = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}'; ${sql}; commit`)
      return r
    } catch (e) {
      try { await dbC.query('rollback') } catch {}
      throw e
    }
  }
  const asUser = async (sql) => {
    try {
      const r = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${USER1}'; ${sql}; commit`)
      const last = Array.isArray(r) ? r[r.length - 1] : r
      return { err: null, rowCount: last && typeof last.rowCount === 'number' ? last.rowCount : (last ? Number(last.rowCount) : 0) }
    } catch (e) {
      try { await dbC.query('rollback') } catch {}
      return { err: e.message, rowCount: 0 }
    }
  }
  const auditOf = async (action) => {
    // action 仅来自脚本内固定字符串（allowlist 动作名），安全插值，避免参数+多语句冲突
    const r = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}';
      select action, count(*)::int c, count(distinct actor_id)::int actors
      from public.audit_logs where action='${action}' group by action; commit`)
    return rowsOf(r)[0] || { c: 0 }
  }

  // C1 created
  await asAdmin(`insert into public.asset_languages (asset_id, language_code, status)
                 select id, 'es', 'draft' from public.assets where slug='published-asset'`, 'C1')
  let a = await auditOf('asset_language.created')
  ok('C1 asset_language.created 落审计', a.c === 1, `rows=${a.c}`)

  // C2 published（draft→published）
  await asAdmin(`update public.asset_languages set status='published'
                 where language_code='es'`, 'C2')
  a = await auditOf('asset_language.published')
  ok('C2 asset_language.published 落审计（语义分离）', a.c === 1, `rows=${a.c}`)
  // 可见集合随之 +1 语言（es 无图，language_count 增 1）
  // C2b visible set semantics: es published -> language_count 2 (bigint -> Number)
  {
    await dbC.query('begin'); await dbC.query('set local role authenticated')
    const r = await dbC.query(`select language_count from public.published_assets where slug='published-asset'`)
    await dbC.query('commit')
    ok('C2b 公开集合语义正确（es published 后 language_count=2）', Number(r.rows[0].language_count) === 2, `language_count=${r.rows[0].language_count}`)
  }

  // C3 unpublished（published→draft）
  await asAdmin(`update public.asset_languages set status='draft'
                 where language_code='es'`, 'C3')
  a = await auditOf('asset_language.unpublished')
  ok('C3 asset_language.unpublished 落审计', a.c === 1, `rows=${a.c}`)

  // C4 updated（业务列实际变化：language_code es→it）
  await asAdmin(`update public.asset_languages set language_code='it'
                 where language_code='es'`, 'C4')
  a = await auditOf('asset_language.updated')
  ok('C4 asset_language.updated 落审计（仅业务列变化）', a.c === 1, `rows=${a.c}`)

  // C4b 纯 touch no-op（status 不变 + 无业务列变化）→ 不新增 updated
  const before4b = (await auditOf('asset_language.updated')).c
  await asAdmin(`update public.asset_languages set status='draft'
                 where language_code='it'`, 'C4b')
  a = await auditOf('asset_language.updated')
  ok('C4b no-op/纯 touch UPDATE 不刷 asset_language.updated', a.c === before4b, `rows=${a.c}`)

  // C5 deleted
  await asAdmin(`delete from public.asset_languages where language_code='it'`, 'C5')
  a = await auditOf('asset_language.deleted')
  ok('C5 asset_language.deleted 落审计', a.c === 1, `rows=${a.c}`)

  // C6 image.updated（sort_order 实际变化）
  await asAdmin(`update public.images set sort_order=9
                 where filename='a.png'`, 'C6')
  a = await auditOf('image.updated')
  ok('C6 image.updated 落审计（sort_order 业务列 WHEN 命中）', a.c === 1, `rows=${a.c}`)

  // C7 image no-op（touch 只刷 updated_at）→ 不新增 image.updated
  const before7 = (await auditOf('image.updated')).c
  await asAdmin(`update public.images set sort_order=sort_order where filename='a.png'`, 'C7')
  a = await auditOf('image.updated')
  ok('C7 no-op UPDATE 不触发 image.updated（WHEN 排除 touch）', a.c === before7, `rows=${a.c}`)

  // C8 DEF-1 修复后：tags 改名成功 + updated_at 落值 + audit tag.updated
  await asAdmin(`update public.tags set name='Renamed Tag' where id='${tag_id}'`, 'C8')
  const tg = await dbC.query(`select name, updated_at is not null as has_ts from public.tags where id='${tag_id}'`)
  a = await auditOf('tag.updated')
  ok('C8 DEF-1 修复：tags 改名成功且 updated_at 已落值', tg.rows[0].name === 'Renamed Tag' && tg.rows[0].has_ts)
  ok('C8b tag.updated 审计随改名恢复（audit_tags_upd 现可用）', a.c >= 1, `rows=${a.c}`)

  // C9 allowlist 边界：24 项内可写，24 项外被 CHECK 拒绝（root 身份，绕 RLS 只测 CHECK）
  {
    try {
      await dbC.query(`insert into public.audit_logs (actor_id, action, target_type, target_id)
                       values ('${ADMIN1}', 'image.updated', 'images', 'x')`)
      ok('C9 allowlist: image.updated 属 24 项内，可插入', true)
    } catch (e) { ok('C9 allowlist: image.updated 插入（期望成功）', false, e.message) }
    try {
      await dbC.query(`insert into public.audit_logs (actor_id, action, target_type, target_id)
                       values ('${ADMIN1}', 'hacker.pwned', 'images', 'x')`)
      ok('C9b allowlist: 越界 action 被 CHECK 拒绝', false, '意外成功')
    } catch (e) {
      ok('C9b allowlist: 越界 action 被 CHECK 拒绝', /check constraint|audit_logs_action_allowlist/i.test(e.message), e.message.slice(0, 80))
    }
  }

  // C10 非 admin 越权负样本（user1 直连）
  //   UPDATE：RLS using(is_admin()) 过滤 → 0 行受影响（非报错，断言无旁路无审计）
  //   INSERT：RLS with check(is_admin()) → 真实报错
  {
    const before = (await auditOf('asset_language.published')).c
    const ru = await asUser(`update public.asset_languages set status='draft' where id='${lang_en}'`)
    ok('C10a user1 UPDATE asset_languages：RLS 过滤 0 行（无旁路）', ru.err === null && ru.rowCount === 0, `rowCount=${ru.rowCount}`)
    const after = (await auditOf('asset_language.published')).c
    ok('C10b user1 UPDATE 不产生任何审计行', after === before, `before=${before} after=${after}`)
    const ri = await asUser(`insert into public.asset_languages (asset_id, language_code, status)
      select id, 'fr', 'draft' from public.assets where slug='published-asset'`)
    ok('C10c user1 INSERT asset_languages 被 RLS WITH CHECK 拒绝', ri.err !== null && /row-level security/i.test(ri.err), (ri.err || 'none').slice(0, 60))
  }

  // C11 状态触发器不会吞掉 created（去重计数核对：5 种语言语义 action 各自独立存在）
  const langs = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}';
    select action, count(*)::int c from public.audit_logs
    where action like 'asset_language.%' group by action order by action; commit`)
  const have = new Set(rowsOf(langs).map(r => r.action))
  ok('C11 asset_language.* 五种语义均独立可产生',
     ['asset_language.created','asset_language.published','asset_language.unpublished','asset_language.updated','asset_language.deleted'].every(x => have.has(x)),
     [...have].join(','))

  // C12 目录完整性：audit_logs allowlist CHECK 恰为 24 项
  const cons = await dbC.query(`select pg_get_constraintdef(oid) d from pg_constraint
    where conname='audit_logs_action_allowlist'`)
  const n24 = (cons.rows[0].d.match(/'([^']+)'/g) || []).length
  ok('C12 allowlist CHECK 枚举恰 24 项', n24 === 24, `count=${n24}`)

  console.log(`\n[result] PASS=${pass} FAIL=${fail}`)
} catch (e) {
  fail++
  console.error('[abort]', e.message)
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try {
    if (mainC) {
      await mainC.query(`drop database if exists ${DBNAME} with (force)`)
      console.log(`[cleanup] isolated db ${DBNAME} dropped`)
      await mainC.end()
    }
  } catch (e) { console.error('[cleanup]', e.message) }
}
process.exit(fail === 0 && pass > 0 ? 0 : 1)
