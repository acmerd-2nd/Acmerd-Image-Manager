// V1.1 Phase A 隔离库冒烟（一次性库，跑完自动 DROP）
// 依据: docs/v1.1/01-design-gate.md Rev B §13.2 C1–C10 + Owner 硬约束 H1/H2
// 用法: node scripts/v11-phase-a-smoke.mjs
// 红线: 全程不触碰生产 public 数据；库名 acmerd_v11_a_<rand>；finally 强制清理。
// 结构:
//   setup(桩) → 0001..0008 → seed → Snapshot A → 0009..0013 → Snapshot B
//   → NO-DRIFT → H1/H2/幂等/C6/权限/allowlist/settings/视图用例 → 幂等重放
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

// 连接候选：直连优先；若 DNS/IPv6 不可达（ENOTFOUND/超时），回退 Supabase Pooler(IPv4)。
// pooler 会话模式支持 CREATE DATABASE / SET ROLE，行为与直连一致（用户 postgres.<ref> → role postgres）。
const REF = new URL(MAINT).hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1]
const MAINT_CANDIDATES = [MAINT]
if (REF) {
  for (const h of ['aws-0-ap-northeast-1.pooler.supabase.com', 'aws-0-ap-southeast-1.pooler.supabase.com']) {
    const u = new URL(MAINT)
    u.hostname = h
    u.username = `postgres.${REF}`
    u.pathname = '/postgres'
    MAINT_CANDIDATES.push(u.toString())
  }
}
const mk = (cs) => new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } })

const DBNAME = `acmerd_v11_a_${Date.now().toString(36).slice(-6)}`

async function pickMaint(log) {
  for (const cs of MAINT_CANDIDATES) {
    const c = mk(cs)
    try {
      await c.connect()
      await c.query('select 1')
      log(`maint connection OK via ${new URL(cs).hostname}`)
      return { client: c, cs }
    } catch (e) {
      try { await c.end() } catch {}
      log(`maint candidate ${new URL(cs).hostname} failed: ${e.code || e.message.slice(0, 60)}`)
    }
  }
  throw new Error('no usable maint connection (direct + pooler all failed)')
}

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

const ADMIN1 = '11111111-1111-4111-8111-111111111111'
const USER1  = '22222222-2222-4222-8222-222222222222'
const USER2  = '33333333-3333-4333-8333-333333333333'
const USER3  = '44444444-4444-4444-8444-444444444444'
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
const MIG_ALL = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const MIG_BASE = MIG_ALL.filter(f => f < '0009')
const MIG_V11  = MIG_ALL.filter(f => f >= '0009')

let mainC = null, dbC = null
try {
  const picked = await pickMaint((s) => console.log(`[conn] ${s}`))
  mainC = picked.client
  await mainC.query(`drop database if exists ${DBNAME} with (force)`)
  await mainC.query(`create database ${DBNAME}`)
  console.log(`[setup] isolated db ${DBNAME} created`)

  dbC = mk((() => { const u = new URL(picked.cs); u.pathname = `/${DBNAME}`; return u.toString() })())
  await dbC.connect()
  await dbC.query(ROOT_STUB)
  console.log('[setup] supabase stub (auth.uid/auth.role/storage/default-privileges) ready')

  for (const f of MIG_BASE) {
    await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  }
  console.log(`[migrate] base applied: ${MIG_BASE.join(', ')}`)

  // ---------- seed（owner 身份绕过 RLS；审计触发器对 auth.uid()=null 自然跳过） ----------
  await dbC.query(`insert into auth.users (id, email) values
    ('${ADMIN1}','admin1@x.test'), ('${USER1}','user1@x.test'), ('${USER2}','user2@x.test')`)
  await dbC.query(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)
  const ares = await dbC.query(`insert into public.assets (name, slug, status, created_by) values
    ('Published Asset', 'published-asset', 'draft', '${ADMIN1}'),
    ('Draft Asset', 'draft-asset', 'draft', '${ADMIN1}') returning id, slug`)
  const pId = ares.rows.find(r => r.slug === 'published-asset').id
  const dId = ares.rows.find(r => r.slug === 'draft-asset').id
  const lang_en = (await dbC.query(`insert into public.asset_languages (asset_id, language_code, status)
    values ('${pId}', 'en', 'published') returning id`)).rows[0].id
  const lang_de = (await dbC.query(`insert into public.asset_languages (asset_id, language_code, status)
    values ('${pId}', 'de', 'draft') returning id`)).rows[0].id
  const imgRes = await dbC.query(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values
    ('${lang_en}', 'a.png', 'published-asset/en/a.png', 1, 100),
    ('${lang_en}', 'b.png', 'published-asset/en/b.png', 2, 200),
    ('${lang_de}', 'c.png', 'published-asset/de/c.png', 1, 300) returning id, filename`)
  const imgA = imgRes.rows.find(r => r.filename === 'a.png').id
  const tag_id = (await dbC.query(`insert into public.tags (name, slug) values ('Original Tag', 'original-tag') returning id`)).rows[0].id
  await dbC.query(`insert into public.asset_tags (asset_id, tag_id) values ('${pId}', '${tag_id}')`)
  await dbC.query(`update public.assets set status='published' where id='${pId}'`)
  // 注：credit_accounts 行在应用 0010 之后补建并设余额（0001–0008 阶段 handle_new_user 尚未扩展）
  console.log('[seed] fixture ready')

  // ---------- Snapshot A（Guest 视角，authenticated 无 JWT，0009 前） ----------
  const SNAP_QUERIES = [
    `select id, name, slug, image_count, language_count, tags::text as tags from public.published_assets order by id`,
    `select count(*)::int c from public.assets a join public.asset_languages l on l.asset_id=a.id where a.status='published' and l.status='published'`,
    `select count(*)::int c from public.images i join public.asset_languages l on i.asset_language_id=l.id join public.assets a on l.asset_id=a.id where a.status='published' and l.status='published'`,
    `select count(*)::int c from public.asset_tags at_ join public.assets a on a.id=at_.asset_id where a.status='published'`,
  ]
  async function snapshot() {
    const out = []
    for (let qi = 0; qi < SNAP_QUERIES.length; qi++) {
      try {
        await dbC.query('begin'); await dbC.query('set local role authenticated')
        const r = await dbC.query(SNAP_QUERIES[qi])
        out.push(JSON.stringify(r.rows)); await dbC.query('commit')
      } catch (e) {
        try { await dbC.query('rollback') } catch (_) {}
        throw new Error(`SNAP_QUERY#${qi + 1} FAILED: ` + e.message)
      }
    }
    return out.join('\n')
  }
  const snapA = await snapshot()

  // ---------- 应用 0009–0013 ----------
  for (const f of MIG_V11) {
    await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
    console.log(`[migrate] ${f} OK`)
  }
  const snapB = await snapshot()
  ok('C2 NO-DRIFT: Guest 视角公开数据集合 0009–0013 前后逐字节一致', snapA === snapB,
     snapA === snapB ? '4 组快照相同' : 'DRIFT DETECTED')

  // 布景补丁：USER1/USER2 建号发生在 0010 之前（旧 handle_new_user 无积分账户），
  // credit_accounts 在 0010 后才存在 → 此处补建并设初始余额（owner 直写，仅测试布景）
  await dbC.query(`insert into public.credit_accounts (user_id) values ('${USER1}'), ('${USER2}')
    on conflict (user_id) do nothing`)
  await dbC.query(`update public.credit_accounts set balance=5 where user_id='${USER1}'`)
  await dbC.query(`update public.credit_accounts set balance=1 where user_id='${USER2}'`)

  // ---------- 身份助手（同 phase8 范式） ----------
  const asAdmin = async (sql) => {
    try {
      return await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}'; ${sql}; commit`)
    } catch (e) { try { await dbC.query('rollback') } catch {} ; throw e }
  }
  const asUser = async (sql) => {
    try {
      const r = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${USER1}'; ${sql}; commit`)
      const last = Array.isArray(r) ? r[r.length - 1] : r
      return { err: null, rowCount: last && typeof last.rowCount === 'number' ? last.rowCount : 0, rows: rowsOf(r) }
    } catch (e) { try { await dbC.query('rollback') } catch {} ; return { err: e.message, rowCount: 0, rows: [] } }
  }
  const asSvc = async (sql) => {
    try {
      const r = await dbC.query(`begin; set local request.jwt.claim.role='service_role'; ${sql}; commit`)
      return { err: null, rows: rowsOf(r) }
    } catch (e) { try { await dbC.query('rollback') } catch {} ; return { err: e.message, rows: [] } }
  }
  const auditOf = async (action) => {
    const r = await dbC.query(`begin; set local role authenticated; set local request.jwt.claim.sub='${ADMIN1}';
      select count(*)::int c from public.audit_logs where action='${action}'; commit`)
    return rowsOf(r)[0]?.c ?? 0
  }

  // ============================================================
  // H1 — Collection Cover 完整性
  // ============================================================
  console.log('\n[H1] Collection Cover 完整性')
  const colA = (await dbC.query(`insert into public.collections (name, slug, status) values ('Massage Products','massage-products','draft') returning id`)).rows[0].id
  const colB = (await dbC.query(`insert into public.collections (name, slug, status) values ('Empty B','empty-b','published') returning id`)).rows[0].id
  await dbC.query(`update public.assets set collection_id='${colA}' where id='${pId}'`)

  // H1a: cover 指向本 Collection 内 Asset 的图 → 允许
  try {
    await dbC.query(`update public.collections set cover_image_id='${imgA}', status='published' where id='${colA}'`)
    ok('H1a cover 指向本 Collection 内 Asset 图片 → 允许', true)
  } catch (e) { ok('H1a cover 指向本 Collection 内 Asset 图片 → 允许', false, e.message.slice(0, 90)) }

  // H1b: cover 指向其它 Collection 范围的图 → 拒绝（colB 无任何归属 Asset）
  try {
    await dbC.query(`update public.collections set cover_image_id='${imgA}' where id='${colB}'`)
    ok('H1b cover 跨 Collection 引用 → 拒绝', false, '意外成功')
  } catch (e) {
    ok('H1b cover 跨 Collection 引用 → 拒绝', /COLLECTION_COVER_MISMATCH/i.test(e.message), e.message.slice(0, 90))
  }

  // H1c: 被 cover 引用的 Asset 不得移出（置空）
  try {
    await dbC.query(`update public.assets set collection_id=null where id='${pId}'`)
    ok('H1c cover 在用 Asset 移出 Collection → 拒绝', false, '意外成功')
  } catch (e) {
    ok('H1c cover 在用 Asset 移出 Collection → 拒绝', /COLLECTION_COVER_IN_USE/i.test(e.message), e.message.slice(0, 90))
  }
  const stillIn = (await dbC.query(`select collection_id from public.assets where id='${pId}'`)).rows[0].collection_id
  ok('H1c2 被拒后 collection_id 未被改动（无部分生效）', stillIn === colA)

  // H1d: 先摘 cover → 移动放行 → 再移回
  await dbC.query(`update public.collections set cover_image_id=null where id='${colA}'`)
  await dbC.query(`update public.assets set collection_id=null where id='${pId}'`)
  await dbC.query(`update public.assets set collection_id='${colA}' where id='${pId}'`)
  await dbC.query(`update public.collections set cover_image_id='${imgA}' where id='${colA}'`)
  ok('H1d 摘 cover 后移动放行、回归归组正常', true)

  // published_collections 视图语义
  await dbC.query('begin'); await dbC.query('set local role authenticated')
  const pc = (await dbC.query(`select slug, asset_count from public.published_collections order by slug`)).rows
  await dbC.query('commit')
  ok('T-view published_collections 仅含 published 且有双层 published Asset 的 Collection',
     pc.length === 1 && pc[0].slug === 'massage-products' && Number(pc[0].asset_count) === 1,
     JSON.stringify(pc))
  // draft Collection 不可见（owner 可见，guest 不可见）
  await dbC.query(`insert into public.collections (name, slug, status) values ('Draft Col','draft-col','draft')`)
  await dbC.query('begin'); await dbC.query('set local role authenticated')
  const pc2 = (await dbC.query(`select slug from public.published_collections where slug='draft-col'`)).rows
  await dbC.query('commit')
  ok('T-view2 draft Collection 对 Guest 不可见', pc2.length === 0)

  // collections RLS: user 无写权限
  const rc = await asUser(`insert into public.collections (name, slug) values ('Hack','hack')`)
  ok('T-rls-collections user INSERT collection 被 RLS 拒绝', rc.err !== null && /row-level security/i.test(rc.err), (rc.err || '').slice(0, 60))
  const ru2 = await asUser(`update public.collections set name='X' where id='${colA}'`)
  ok('T-rls-collections2 user UPDATE collection 过滤 0 行', ru2.err === null && ru2.rowCount === 0, `rowCount=${ru2.rowCount}`)

  // collections 审计（admin 路径）
  await asAdmin(`insert into public.collections (name, slug) values ('Audit Col','audit-col')`)
  ok('T-audit collection.created 落审计（admin 直写）', (await auditOf('collection.created')) >= 1)
  await asAdmin(`update public.collections set status='published' where slug='audit-col'`)
  ok('T-audit2 collection.published 状态化审计', (await auditOf('collection.published')) >= 1)
  await asAdmin(`update public.collections set description='d' where slug='audit-col'`)
  ok('T-audit3 collection.updated 落审计（非 status 变更）', (await auditOf('collection.updated')) >= 1)

  // ============================================================
  // images 来源模型（D3 方案 A）
  // ============================================================
  console.log('\n[D3] images provider/source_path')
  try {
    await dbC.query(`insert into public.images (asset_language_id, filename, provider, source_path, sort_order)
      values ('${lang_de}', 'g.webp', 'github', 'assets/${pId}/de/g.webp', 2)`)
    ok('D3a github 行（storage_path null + source_path）→ 允许', true)
  } catch (e) { ok('D3a github 行 → 允许', false, e.message.slice(0, 90)) }
  try {
    await dbC.query(`insert into public.images (asset_language_id, filename, provider, source_path, storage_path)
      values ('${lang_de}', 'bad.webp', 'github', 'assets/x.webp', 'images/x.webp')`)
    ok('D3b github 行带 storage_path → CHECK 拒绝（互斥）', false, '意外成功')
  } catch (e) {
    ok('D3b github 行带 storage_path → CHECK 拒绝（互斥）', /images_source_check/i.test(e.message), e.message.slice(0, 80))
  }
  const legacy = (await dbC.query(`select count(*)::int c from public.images where provider='supabase_storage' and storage_path is not null`)).rows[0].c
  ok('D3c 存量行 provider 默认 supabase_storage 且 storage_path 语义不变', legacy >= 3, `rows=${legacy}`)

  // ============================================================
  // account_origin（D10）
  // ============================================================
  console.log('\n[D10] account_origin')
  const ao = (await dbC.query(`select account_origin from public.profiles where id='${USER1}'`)).rows[0].account_origin
  ok('D10a 默认 account_origin=registered', ao === 'registered')
  try {
    await dbC.query(`update public.profiles set account_origin='seed' where id='${USER1}'`)
    await dbC.query(`update public.profiles set account_origin='registered' where id='${USER1}'`)
    ok('D10b seed/registered 合法值可写', true)
  } catch (e) { ok('D10b seed/registered 合法值可写', false, e.message.slice(0, 80)) }
  try {
    await dbC.query(`update public.profiles set account_origin='wizard' where id='${USER1}'`)
    ok('D10c 非法 origin 被 CHECK 拒绝', false, '意外成功')
  } catch (e) {
    ok('D10c 非法 origin 被 CHECK 拒绝', /profiles_account_origin_check/i.test(e.message), e.message.slice(0, 80))
  }

  // ============================================================
  // Credits —— handle_new_user / 权限 / 原子 / H2 幂等 / C6 并发 / refund
  // ============================================================
  console.log('\n[Credits] 模型与原子性')
  // 建号 → 积分账户自动创建
  await dbC.query(`insert into auth.users (id, email) values ('${USER3}','user3@x.test')`)
  const acc3 = (await dbC.query(`select balance, unlimited from public.credit_accounts where user_id='${USER3}'`)).rows[0]
  ok('CR1 handle_new_user 自动创建 credit_accounts(0,false)',
     acc3 && Number(acc3.balance) === 0 && acc3.unlimited === false)

  // 客户端零写（grants revoke → permission denied）
  const w1 = await asUser(`update public.credit_accounts set balance=999 where user_id='${USER1}'`)
  ok('CR2 user UPDATE credit_accounts → permission denied', w1.err !== null && /permission denied/i.test(w1.err), (w1.err || '').slice(0, 60))
  const w2 = await asUser(`insert into public.credit_transactions (user_id, type, amount, balance_after) values ('${USER1}','admin_adjustment',999,999)`)
  ok('CR3 user INSERT credit_transactions → permission denied', w2.err !== null && /permission denied/i.test(w2.err), (w2.err || '').slice(0, 60))
  const w3 = await asUser(`update public.site_settings set value='0' where key='package_download_cost'`)
  ok('CR4 user UPDATE site_settings → permission denied', w3.err !== null && /permission denied/i.test(w3.err), (w3.err || '').slice(0, 60))
  const r1 = await asUser(`select balance from public.credit_accounts where user_id='${USER1}'`)
  ok('CR5 user 读自己余额 → 可见', r1.err === null && Number(r1.rows[0]?.balance) === 5, `balance=${r1.rows[0]?.balance}`)
  const r2 = await asUser(`select balance from public.credit_accounts where user_id='${USER2}'`)
  ok('CR6 user 读他人余额 → 0 行（RLS）', r2.err === null && r2.rows.length === 0)
  const r3 = await asUser(`select count(*)::int c from public.site_settings`)
  ok('CR7 settings 对 authenticated 可读（5 key）', r3.err === null && r3.rows[0].c === 5, `rows=${r3.rows[0]?.c}`)

  // RPC execute 权限（authenticated 被 revoke）
  const w4 = await asUser(`select public.deduct_credits('${USER1}','image_download',1,'x')`)
  ok('CR8 user 直调 deduct_credits → permission denied', w4.err !== null && /permission denied/i.test(w4.err), (w4.err || '').slice(0, 60))

  // 正常扣分（service role 通道）
  const d1 = await asSvc(`select public.deduct_credits('${USER1}','image_download',1,'key-img-1','image','img-x') as b`)
  ok('CR9 service role 扣 1 分成功，balance_after=4', d1.err === null && Number(d1.rows[0]?.b) === 4, `b=${d1.rows[0]?.b}`)
  // 余额不足（user2 balance=1 扣 2）
  const d2 = await asSvc(`select public.deduct_credits('${USER2}','image_download',2,'key-x') as b`)
  ok('CR10 余额不足 → INSUFFICIENT_CREDITS 拒绝', d2.err !== null && /INSUFFICIENT_CREDITS/i.test(d2.err), (d2.err || '').slice(0, 70))
  const b2 = (await dbC.query(`select balance from public.credit_accounts where user_id='${USER2}'`)).rows[0].balance
  ok('CR11 拒绝后余额未被改动（无部分生效）', Number(b2) === 1, `balance=${b2}`)

  // H2 幂等三态
  const d3 = await asSvc(`select public.deduct_credits('${USER1}','image_download',1,'key-img-1','image','img-x') as b`)
  ok('H2a 同 key 同参 → 返回原结果且不重复扣', d3.err === null && Number(d3.rows[0]?.b) === 4, `b=${d3.rows[0]?.b}`)
  const cnt1 = (await dbC.query(`select count(*)::int c from public.credit_transactions where idempotency_key='key-img-1'`)).rows[0].c
  ok('H2a2 ledger 仅 1 行（未重复落账）', cnt1 === 1, `rows=${cnt1}`)
  const d4 = await asSvc(`select public.deduct_credits('${USER1}','image_download',2,'key-img-1','image','img-x') as b`)
  ok('H2b 同 key 异参 → IDEMPOTENCY_CONFLICT', d4.err !== null && /IDEMPOTENCY_CONFLICT/i.test(d4.err), (d4.err || '').slice(0, 70))
  const d5 = await asSvc(`select public.deduct_credits('${USER2}','image_download',1,'key-img-1') as b`)
  ok('H2c 同 key 异用户 → IDEMPOTENCY_CONFLICT', d5.err !== null && /IDEMPOTENCY_CONFLICT/i.test(d5.err), (d5.err || '').slice(0, 70))

  // unlimited 旁路
  await dbC.query(`update public.credit_accounts set unlimited=true where user_id='${USER3}'`)
  const d6 = await asSvc(`select public.deduct_credits('${USER3}','image_download',1,'key-u1') as b`)
  const ledgerU = (await dbC.query(`select count(*)::int c from public.credit_transactions where user_id='${USER3}'`)).rows[0].c
  ok('H2d unlimited=true → 0 余额可下载且不写扣账流水', d6.err === null && Number(d6.rows[0]?.b) === 0 && ledgerU === 0,
     `b=${d6.rows[0]?.b} ledger=${ledgerU}`)

  // C6 并发原子性：余额 1，两个并发单图扣分 → 恰一成功
  {
    const cA = mk((() => { const u = new URL(picked.cs); u.pathname = `/${DBNAME}`; return u.toString() })())
    const cB = mk((() => { const u = new URL(picked.cs); u.pathname = `/${DBNAME}`; return u.toString() })())
    await cA.connect(); await cB.connect()
    const q = (c) => c.query(`begin; set local request.jwt.claim.role='service_role';
      select public.deduct_credits('${USER2}','image_download',1,'conc-1') as b; commit`)
    const [ra, rb] = await Promise.allSettled([q(cA), q(cB)])
    const wins = [ra, rb].filter(x => x.status === 'fulfilled').length
    const fails = [ra, rb].filter(x => x.status === 'rejected' && /INSUFFICIENT_CREDITS/i.test(String(x.reason?.message || x.reason))).length
    const finalB = (await dbC.query(`select balance from public.credit_accounts where user_id='${USER2}'`)).rows[0].balance
    ok('C6 并发双扣余额 1 → 恰一成功一拒绝、终态 0 且无负余额',
       wins === 1 && fails === 1 && Number(finalB) === 0, `wins=${wins} fails=${fails} balance=${finalB}`)
    try { await cA.end(); await cB.end() } catch {}
  }

  // adjust_credits（Set Balance）
  const adj = await asSvc(`select public.adjust_credits('${USER1}', 120, 'Promotion', '${ADMIN1}') as b`)
  ok('CR12 Set Balance 120 → 生效且 ledger 记 admin_adjustment', adj.err === null && Number(adj.rows[0]?.b) === 120, `b=${adj.rows[0]?.b}`)
  const adjRow = (await dbC.query(`select amount, balance_after, metadata from public.credit_transactions
    where type='admin_adjustment' and user_id='${USER1}' order by id desc limit 1`)).rows[0]
  ok('CR12b admin_adjustment ledger: amount=+116（120-4）, metadata from/to/reason',
     Number(adjRow.amount) === 116 && Number(adjRow.balance_after) === 120
       && Number(adjRow.metadata.from) === 4 && Number(adjRow.metadata.to) === 120 && adjRow.metadata.reason === 'Promotion',
     JSON.stringify(adjRow.metadata))

  // refund（H2: 一 debit 一 refund）
  const debit = (await dbC.query(`select id from public.credit_transactions
    where user_id='${USER1}' and type='image_download' order by id limit 1`)).rows[0].id
  const rf1 = await asSvc(`select public.refund_credits(${debit}, 'rf-1') as b`)
  ok('CR13 refund → balance 回升 121，refund ledger 落行', rf1.err === null && Number(rf1.rows[0]?.b) === 121, `b=${rf1.rows[0]?.b}`)
  const rf2 = await asSvc(`select public.refund_credits(${debit}, 'rf-1-retry') as b`)
  const refundCnt = (await dbC.query(`select count(*)::int c from public.credit_transactions
    where type='download_refund' and reference_id='${debit}'`)).rows[0].c
  ok('CR14 同 debit 重复 refund → 幂等返回、仍仅 1 条 refund 行', rf2.err === null && Number(rf2.rows[0]?.b) === 121 && refundCnt === 1,
     `b=${rf2.rows[0]?.b} refundRows=${refundCnt}`)
  const adjId = (await dbC.query(`select id from public.credit_transactions where type='admin_adjustment' limit 1`)).rows[0].id
  const rf3 = await asSvc(`select public.refund_credits(${adjId}) as b`)
  ok('CR15 对非下载 debit refund → DEBIT_NOT_FOUND', rf3.err !== null && /DEBIT_NOT_FOUND/i.test(rf3.err), (rf3.err || '').slice(0, 70))

  // credit_transactions user 读面
  const tx1 = await asUser(`select count(*)::int c from public.credit_transactions where user_id='${USER1}'`)
  ok('CR16 user 读自己流水 → 可见', tx1.err === null && tx1.rows[0].c >= 2, `rows=${tx1.rows[0]?.c}`)
  const tx2 = await asUser(`select count(*)::int c from public.credit_transactions where user_id is null`)
  ok('CR17 user 不能读 user_id=null 的他人流水', tx2.err === null && tx2.rows[0].c === 0)

  // ============================================================
  // allowlist / settings 幂等重放
  // ============================================================
  console.log('\n[0013/幂等] allowlist 与重放')
  const cons = await dbC.query(`select pg_get_constraintdef(oid) d from pg_constraint
    where conname='audit_logs_action_allowlist'`)
  const n34 = (cons.rows[0].d.match(/'([^']+)'/g) || []).length
  ok('AL1 allowlist CHECK 枚举恰 34 项', n34 === 34, `count=${n34}`)
  try {
    await dbC.query(`insert into public.audit_logs (actor_id, action, target_type, target_id)
                     values ('${ADMIN1}', 'settings.updated', 'site_settings', 'k')`)
    ok('AL2 settings.updated 属 34 项内可写', true)
    await dbC.query(`delete from public.audit_logs where action='settings.updated'`)
  } catch (e) { ok('AL2 settings.updated 属 34 项内可写', false, e.message.slice(0, 80)) }
  try {
    await dbC.query(`insert into public.audit_logs (actor_id, action, target_type, target_id)
                     values ('${ADMIN1}', 'hacker.pwned', 'x', 'x')`)
    ok('AL3 越界 action 仍被 CHECK 拒绝', false, '意外成功')
  } catch (e) {
    ok('AL3 越界 action 仍被 CHECK 拒绝', /check constraint|audit_logs_action_allowlist/i.test(e.message), e.message.slice(0, 80))
  }

  // V11 migrations 幂等重放（全部重跑一遍，状态必须不变）
  const beforeReplay = (await dbC.query(`select
    (select count(*)::int from public.collections) c,
    (select count(*)::int from public.credit_transactions) t,
    (select count(*)::int from public.site_settings) s`)).rows[0]
  for (const f of MIG_V11) {
    await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  }
  const afterReplay = (await dbC.query(`select
    (select count(*)::int from public.collections) c,
    (select count(*)::int from public.credit_transactions) t,
    (select count(*)::int from public.site_settings) s`)).rows[0]
  ok('RP 0009–0013 全量重放幂等（行数不变）',
     JSON.stringify(beforeReplay) === JSON.stringify(afterReplay),
     JSON.stringify({ before: beforeReplay, after: afterReplay }))
  const seedVal = (await dbC.query(`select value from public.site_settings where key='package_download_cost'`)).rows[0].value
  ok('RP2 settings 种子重放不覆盖（on conflict do nothing）', seedVal === 15 || seedVal === '15', `value=${seedVal}`)

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
