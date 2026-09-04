// ============================================================
// V1.1 Phase B (PB-1) 隔离库冒烟 — 0014 GitHub 地基
// 范式沿 v11-phase-a-smoke.mjs（一次性库、supabase 桩、快照对比、负样本）。
// 覆盖（Gate 04 §9-6）:
//   * 0001→0014 全链应用 + 全量重放幂等
//   * C2 NO-DRIFT（全 ready 存量数据下 Guest 视角逐字节一致）
//   * 租约 RPC: 抢占/互斥/过期恢复/仅持有者释放/service_role 专属
//   * images.status 四态: 默认 ready / CHECK 拒非法 / 非 ready 对 Guest 不可见
//     （RLS select 策略 + published_assets 视图 + Worker 下载同款 status=eq.ready 查询）
//   * source_sha 列 + 审计 allowlist 38（github.* 可写、越界仍拒）
// ============================================================
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const MAINT = process.env.DATABASE_URL
if (!MAINT) { console.error('DATABASE_URL is not set'); process.exit(2) }

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
const DBNAME = `acmerd_v11_b_${Date.now().toString(36).slice(-6)}`

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
const MIG_V11 = MIG_ALL.filter(f => f >= '0009')

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
  console.log('[setup] supabase stub ready')

  for (const f of MIG_BASE) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  console.log(`[migrate] base applied (${MIG_BASE.length} files)`)

  // ---------- seed ----------
  await dbC.query(`insert into auth.users (id, email) values ('${ADMIN1}','admin1@x.test'), ('${USER1}','user1@x.test')`)
  await dbC.query(`update public.user_roles set role='admin' where user_id='${ADMIN1}'`)
  const ares = await dbC.query(`insert into public.assets (name, slug, status, created_by)
    values ('Pub Asset', 'pub-asset', 'draft', '${ADMIN1}') returning id`)
  const pId = ares.rows[0].id
  const langEn = (await dbC.query(`insert into public.asset_languages (asset_id, language_code, status)
    values ('${pId}', 'en', 'published') returning id`)).rows[0].id
  const imgRes = await dbC.query(`insert into public.images (asset_language_id, filename, storage_path, sort_order, file_size) values
    ('${langEn}', 'a.png', 'pub-asset/en/a.png', 1, 100) returning id`)
  const imgSupabase = imgRes.rows[0].id
  await dbC.query(`update public.assets set status='published' where id='${pId}'`)

  // ---------- Snapshot A（Guest 视角，0009 前） ----------
  const SNAP_QUERIES = [
    `select id, name, slug, image_count, language_count from public.published_assets order by id`,
    `select count(*)::int c from public.images i join public.asset_languages l on i.asset_language_id=l.id
      join public.assets a on l.asset_id=a.id where a.status='published' and l.status='published'`,
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
        throw new Error(`SNAP#${qi + 1} FAILED: ` + e.message)
      }
    }
    return out.join('\n')
  }
  const snapA = await snapshot()

  // ---------- 应用 0009–0014 ----------
  for (const f of MIG_V11) {
    await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
    console.log(`[migrate] ${f} OK`)
  }
  const snapB = await snapshot()
  ok('C2 NO-DRIFT: 全 ready 存量数据下 Guest 视角 0009–0014 前后逐字节一致', snapA === snapB,
     snapA === snapB ? '2 组快照相同' : 'DRIFT DETECTED')

  // ---------- helpers ----------
  const asSvc = async (sql) => {
    try {
      const r = await dbC.query(`begin; set local request.jwt.claim.role='service_role'; ${sql}; commit`)
      return { err: null, rowCount: Array.isArray(r) ? (r[r.length - 1]?.rowCount ?? 0) : (r?.rowCount ?? 0), rows: rowsOf(r) }
    } catch (e) { try { await dbC.query('rollback') } catch {} ; return { err: e.message, rowCount: 0, rows: [] } }
  }
  const asAnon = async (sql) => {
    try {
      const r = await dbC.query(`begin; set local role authenticated; ${sql}; commit`)
      const last = Array.isArray(r) ? r[r.length - 1] : r
      return { err: null, rowCount: last?.rowCount ?? 0, rows: rowsOf(r) }
    } catch (e) { try { await dbC.query('rollback') } catch {} ; return { err: e.message, rowCount: 0, rows: [] } }
  }

  // ============================================================
  console.log('\n[0014] images.status 四态与可见性')
  // ============================================================
  const defRow = (await dbC.query(`select status, provider, source_sha is null as no_sha from public.images where id='${imgSupabase}'`)).rows[0]
  ok('S1 存量行默认 status=ready', defRow?.status === 'ready', JSON.stringify(defRow))

  const badStatus = await asSvc(`insert into public.images (asset_language_id, filename, provider, source_path, status, sort_order)
    values ('${langEn}', 'x.png', 'github', 'assets/${pId}/en/x.png', 'bogus', 99)`)
  ok('S2 非法 status 被 CHECK 拒绝', badStatus.err !== null && badStatus.err.includes('images_status_check'),
     badStatus.err?.slice(0, 60))

  const ghUploading = await asSvc(`insert into public.images (asset_language_id, filename, provider, storage_path, source_path, source_sha, mime_type, file_size, sort_order, status)
    values ('${langEn}', 'up.png', 'github', null, 'assets/${pId}/en/02-upload.png', 'deadbeef', 'image/png', 123, 2, 'uploading') returning id`)
  const ghId = ghUploading.rows[0]?.id
  ok('S3 uploading github 行（storage_path null + source_path + source_sha）可插入', ghUploading.err === null && !!ghId)

  const anonSee = await asAnon(`select count(*)::int c from public.images where id='${ghId}'`)
  ok('S4 非 ready 行对 Guest RLS 不可见', anonSee.err === null && anonSee.rows[0]?.c === 0, `count=${anonSee.rows[0]?.c}`)

  const svcSee = await asSvc(`select count(*)::int c from public.images where id='${ghId}'`)
  ok('S5 service role 可见非 ready 行（sweeper/管理路径）', svcSee.rows[0]?.c === 1)

  const viewCount = await asAnon(`select image_count from public.published_assets where slug='pub-asset'`)
  ok('S6 published_assets 视图只计 ready（image_count=1 不含 uploading）', Number(viewCount.rows[0]?.image_count) === 1,
     `image_count=${viewCount.rows[0]?.image_count}`)

  const dlQuery = await asSvc(`select count(*)::int c from public.images where id='${ghId}' and status=eq.ready`.replace('status=eq.ready', "status='ready'"))
  ok('S7 Worker 下载同款 status=ready 过滤 → 0 行（上传中不可下载）', dlQuery.rows[0]?.c === 0)

  // ============================================================
  console.log('\n[0014] 租约 claim/release')
  // ============================================================
  const KEY = `al:${langEn}`
  const c1 = await asSvc(`select public.claim_github_lease('${KEY}', 'worker-a', 120) as got`)
  ok('L1 首次抢占 → true', c1.rows[0]?.got === true)

  const c2 = await asSvc(`select public.claim_github_lease('${KEY}', 'worker-b', 120) as got`)
  ok('L2 未过期期间他人抢占 → false（LEASE_BUSY）', c2.rows[0]?.got === false, `got=${c2.rows[0]?.got}`)

  const c3 = await asSvc(`select public.claim_github_lease('${KEY}', 'worker-a', 120) as got`)
  ok('L3 未过期期间重复 claim → false（每请求新 owner id，无重入语义）', c3.rows[0]?.got === false)

  const wrongRelease = await asSvc(`select public.release_github_lease('${KEY}', 'worker-ghost')`)
  const afterWrong = await asSvc(`select owner_id from public.github_write_leases where resource_key='${KEY}'`)
  ok('L4 非持有者 release 无副作用', wrongRelease.err === null && afterWrong.rows[0]?.owner_id === 'worker-a')

  await dbC.query(`update public.github_write_leases set expires_at = now() - interval '1 second' where resource_key='${KEY}'`)
  const c4 = await asSvc(`select public.claim_github_lease('${KEY}', 'worker-b', 120) as got`)
  ok('L5 租约过期后他人可抢占（异常恢复窗口）→ true', c4.rows[0]?.got === true)

  const rel = await asSvc(`select public.release_github_lease('${KEY}', 'worker-b')`)
  const gone = await asSvc(`select count(*)::int c from public.github_write_leases where resource_key='${KEY}'`)
  ok('L6 持有者 release → 租约删除', rel.err === null && gone.rows[0]?.c === 0)

  const anonClaim = await asAnon(`select public.claim_github_lease('al:hack', 'x', 120) as got`)
  ok('L7 anon/authenticated 调 claim → permission denied', anonClaim.err !== null && anonClaim.err.includes('permission denied'),
     anonClaim.err?.slice(0, 50))

  // ============================================================
  console.log('\n[0014] 审计 allowlist 38 与重放幂等')
  // ============================================================
  const okAudit = await asSvc(`insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values ('${ADMIN1}', 'github.upload.recovered', 'images', '${ghId}', '{}'::jsonb)`)
  ok('A1 github.* 动作可写（38 项 allowlist）', okAudit.err === null)
  const badAudit = await asSvc(`insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values ('${ADMIN1}', 'github.bogus', 'images', '${ghId}', '{}'::jsonb)`)
  ok('A2 越界 action 仍被 CHECK 拒绝', badAudit.err !== null && badAudit.err.includes('audit_logs_action_allowlist'))

  const counts = async () => {
    const r = await dbC.query(`select
      (select count(*)::int from public.images) i,
      (select count(*)::int from public.credit_transactions) t,
      (select count(*)::int from public.site_settings) s,
      (select count(*)::int from public.github_write_leases) l`)
    return JSON.stringify(r.rows[0])
  }
  const before = await counts()
  for (const f of MIG_V11) await dbC.query(readFileSync(join(MIG_DIR, f), 'utf8'))
  const after = await counts()
  ok('RP 0009–0014 全量重放幂等（行数不变）', before === after, `before=${before} after=${after}`)

  const seedVal = (await dbC.query(`select value from public.site_settings where key='package_download_cost'`)).rows[0]?.value
  ok('RP2 settings 种子重放不覆盖', seedVal == 15, `value=${seedVal}`)

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
  process.exit(fail > 0 ? 1 : 0)
}
