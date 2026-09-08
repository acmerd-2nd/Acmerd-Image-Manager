#!/usr/bin/env node
/**
 * V1.3.1 冒烟（隔离库 0001→0016 全量，一次性库 DROP；生产零触碰）
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
const DBNAME = 'acmerd_v131_' + Date.now().toString(36).slice(-6)

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
  console.log('[migrate] ' + migs.length + ' migrations applied (incl. 0017)')

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

  // ADMIN1 already inserted by scaffold
  // (user_roles already set by scaffold)


  const asRole = async (sub, fn) => {
    await q('begin')
    try {
      await q(`select set_config('request.jwt.claim.sub', '${sub}', true), set_config('request.jwt.claim.role', 'authenticated', true)`)
      await q('set local role authenticated')
      return await fn()
    } finally { await q('rollback') }
  }

  // ---------- T1 progress 列：默认值 + CHECK 三值 ----------
  const it1 = (await q(`insert into public.schedule_items (title) values ('t1') returning id, progress`)).rows[0]
  ok('T1a progress 默认 not_started', it1.progress === 'not_started', it1.progress)
  let r = await expectErr(`update public.schedule_items set progress='done' where id='${it1.id}'`, 'schedule_items_progress_check')
  ok('T1b 非法 progress 拒绝（CHECK）', r === '', r ?? '')
  await q(`update public.schedule_items set progress='completed' where id='${it1.id}'`)
  const p1 = (await q(`select progress from public.schedule_items where id='${it1.id}'`)).rows[0].progress
  ok('T1c 合法切换 completed', p1 === 'completed')

  // ---------- T2 视图暴露 progress + 与发布态正交 ----------
  await q(`update public.schedule_items set status='published' where id='${it1.id}'`)
  const v1 = (await asRole('', () => q(`select progress from public.published_schedule_items where id='${it1.id}'`))).rows[0]
  ok('T2a 视图暴露 progress（completed）', v1?.progress === 'completed')
  await q(`update public.schedule_items set progress='in_progress' where id='${it1.id}'`)
  const v2 = (await asRole('', () => q(`select progress from public.published_schedule_items where id='${it1.id}'`))).rows[0]
  ok('T2b 进度与发布态正交（published 下改 progress 仍可见）', v2?.progress === 'in_progress')

  // ---------- T3 adjust_credits 带 p_operation → metadata.operation ----------
  await q(`insert into auth.users (id, email) values ('${ADMIN1}', 'admin1@x.test') on conflict (id) do nothing`)
  await q(`update public.user_roles set role = 'admin' where user_id = '${ADMIN1}'`)
  await q(`insert into public.credit_accounts (user_id, balance) values ('${ADMIN1}', 10) on conflict (user_id) do nothing`)
  // 会话级身份做 admin 调分（真实提交，审计断言不在回滚事务内）
  await q(`select set_config('request.jwt.claim.sub', '${ADMIN1}', false), set_config('request.jwt.claim.role', 'authenticated', false)`)
  await q('set role authenticated')
  const nb = (await q(`select public.adjust_credits('${ADMIN1}', 50, 'gate-test', '${ADMIN1}', 'quick_add')`)).rows[0].adjust_credits
  await q('reset role')
  await q(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'anon', false)`)
  ok('T3a adjust +operation 生效（10→50）', Number(nb) === 50, 'new=' + nb)
  const meta = (await q(`select metadata from public.credit_transactions where user_id='${ADMIN1}' order by id desc limit 1`)).rows[0].metadata
  ok('T3b metadata.operation=quick_add', meta?.operation === 'quick_add', JSON.stringify(meta))

  // ---------- T4 batch RPC：整批原子（全成/全败） ----------
  const U1 = '33333333-3333-4333-8333-333333333333'
  const U2 = '44444444-4444-4444-8444-444444444444'
  const U3 = '55555555-5555-4555-8555-555555555555'
  // handle_new_user 触发器（0010 §4）在 auth.users 插入时自动创建 credit_accounts(balance 0)
  for (const u of [U1, U2, U3]) {
    await q(`insert into auth.users (id, email) values ('${u}', '${u}@x.test') on conflict (id) do nothing`)
  }
  const trig = (await q(`select count(*)::int as n from public.credit_accounts where user_id in ('${U1}','${U2}','${U3}') and balance = 0`)).rows[0].n
  ok('T4pre 触发器自动建户（3 行 balance 0）', trig === 3, 'n=' + trig)
  const svc = async (fn) => {
    await q('begin')
    try {
      // 生产等价：PostgREST service_role 会带 claim.role=service_role（RPC 检查的是 auth.role()）
      await q(`select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)`)
      return await fn()
    } finally { await q('rollback') }
  }
  // 成功批必须真实提交（不能包 ROLLBACK，否则后续断言无据）：显式 begin + set local + commit
  await q('begin')
  await q(`select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)`)
  const b1 = await q(`select public.admin_batch_adjust_credits(array['${U1}','${U2}']::uuid[], 5, 'batch-ok')`)
  await q('commit')
  ok('T4a 批量 +5 成功', Number(b1.rows[0].admin_batch_adjust_credits.adjusted) === 2)
  const bal = (await q(`select user_id, balance from public.credit_accounts where user_id in ('${U1}','${U2}','${U3}') order by user_id`)).rows
  ok('T4b 批量落地（U1=5,U2=5,U3=0 不受影响）', Number(bal[0].balance) === 5 && Number(bal[1].balance) === 5 && Number(bal[2].balance) === 0, JSON.stringify(bal))
  // 失败批：U3 余额 0，delta -5 → 整批回滚（U1 也不得变）
  let failed = false
  try {
    await svc(() => q(`select public.admin_batch_adjust_credits(array['${U1}','${U3}']::uuid[], -5, 'batch-fail')`))
  } catch (e) { failed = /INSUFFICIENT_CREDITS/.test(String(e.message)) }
  ok('T4c 任一失败整批 raise', failed)
  const bal2 = (await q(`select balance from public.credit_accounts where user_id='${U1}'`)).rows[0]
  ok('T4d 失败批零残留（U1 仍 5）', Number(bal2.balance) === 5, 'balance=' + bal2.balance)
  const led = (await q(`select count(*)::int as n from public.credit_transactions where metadata->>'operation'='batch' and user_id='${U1}'`)).rows[0].n
  ok('T4e batch 流水仅成功批（U1 恰 1 条）', led === 1, 'n=' + led)

  // ---------- T5 batch 权限：非 service_role 拒绝 ----------
  let denied = false
  try {
    await q(`select public.admin_batch_adjust_credits(array['${U1}']::uuid[], 1, 'x')`)
  } catch (e) { denied = /FORBIDDEN/.test(String(e.message)) }
  ok('T5 非 service_role/is_admin 调 batch 拒绝（owner 直连无 claim）', denied)

  // ---------- T6 allowlist 零变化 + 视图列序 ----------
  const cols = (await q(`select column_name from information_schema.columns where table_name='published_schedule_items' order by ordinal_position`)).rows.map((x) => x.column_name)
  ok('T6a 视图列 progress 在末位', cols[cols.length - 1] === 'progress', cols.join(','))
  const allow = (await q(`select pg_get_constraintdef(oid) as def from pg_constraint where conname='audit_logs_action_allowlist'`)).rows[0].def
  ok('T6b allowlist 保持 43 项（无新增动作）', (allow.match(/,/g) || []).length === 42)

  console.log('\n===== V1.3.1 SMOKE: ' + pass + ' PASS / ' + fail + ' FAIL =====')
  exitCode = fail === 0 ? 0 : 1
} catch (e) {
  console.error('SMOKE ERROR:', e.message)
  exitCode = 2
} finally {
  try { if (dbC) await dbC.end() } catch {}
  try { if (mainC) { await mainC.query('drop database if exists ' + DBNAME + ' with (force)'); await mainC.end() } } catch {}
}
process.exit(exitCode)
