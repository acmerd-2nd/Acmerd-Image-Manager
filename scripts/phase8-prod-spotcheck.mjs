// Phase 8 生产只读 + 安全构造抽查（可复跑）
// 红线：全程不提交任何数据变更——所有写操作在单事务内执行并最终 ROLLBACK；
//       结构检查为只读。审计写入链路用“事务内触发 + 回滚”方式在真实生产环境验证。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  cond ? pass++ : fail++
}

await c.connect()
try {
  // ---------- 1. 结构只读 sanity ----------
  const mig = await c.query(`select filename from schema_migrations where filename like '0007%'`)
  ok('S1 生产 schema_migrations 记录 0007', mig.rows[0]?.filename === '0007_audit_hardening.sql')

  const chk = await c.query(`select pg_get_constraintdef(oid) def from pg_constraint
    where conrelid='public.audit_logs'::regclass and contype='c'`)
  const items = [...chk.rows[0].def.matchAll(/'([a-z_]+(?:\.[a-z_]+)?)'::text/g)].map((m) => m[1])
  ok('S2 allowlist 总项数 = 24', items.length === 24, `count=${items.length}`)
  ok('S3 含 5×asset_language.*', ['created','published','unpublished','updated','deleted']
    .every((s) => items.includes('asset_language.' + s)))
  ok('S4 含 image.updated', items.includes('image.updated'))

  const tg = await c.query(`select tgname from pg_trigger
    where tgrelid='public.asset_languages'::regclass and not tgisinternal and tgname like 'audit_%'`)
  ok('S5 asset_languages 4 审计触发器', tg.rows.length === 4, tg.rows.map((r) => r.tgname).join(','))

  const imgUpd = await c.query(`select 1 from pg_trigger
    where tgrelid='public.images'::regclass and tgname='audit_images_upd'`)
  ok('S6 images audit_images_upd 触发器', imgUpd.rows.length === 1)

  const col = await c.query(`select is_nullable, column_default from information_schema.columns
    where table_schema='public' and table_name='tags' and column_name='updated_at'`)
  ok('S7 tags.updated_at NOT NULL default now()',
    col.rows[0]?.is_nullable === 'NO' && col.rows[0]?.column_default === 'now()')

  // ---------- 2. 选取可安全构造的目标（只读） ----------
  // 已发布资产的已发布语言行 + 其下图片 + 真实活跃 admin
  const tgt = await c.query(`
    select al.id lang_id, al.asset_id, al.status lang_status,
           (select i.id from public.images i where i.asset_language_id = al.id order by i.sort_order limit 1) img_id
    from public.asset_languages al
    join public.assets a on a.id = al.asset_id
    where a.status = 'published' and al.status = 'published'
    limit 1`)
  if (!tgt.rows[0]) { console.log('SKIP: 无已发布资产语言行可构造（生产数据为空？）'); process.exit(2) }
  const { lang_id, asset_id, img_id } = tgt.rows[0]
  const adm = await c.query(`select ur.user_id from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.role='admin' and p.disabled = false limit 1`)
  if (!adm.rows[0]) { console.log('SKIP: 无活跃 admin 身份'); process.exit(2) }
  const adminId = adm.rows[0].user_id
  console.log(`[target] lang_id=${lang_id} asset_id=${asset_id} img_id=${img_id} admin=${adminId}`)

  // ---------- 3. 事务内审计写入链路冒烟（最终 ROLLBACK，零残留） ----------
  await c.query('begin')
  try {
    await c.query(`set local role authenticated; set local request.jwt.claim.sub = '${adminId}'`)

    // 3a. 语言 published→draft → asset_language.unpublished
    await c.query(`update public.asset_languages set status='draft' where id='${lang_id}'`)
    // 3b. 语言 draft→published → asset_language.published
    await c.query(`update public.asset_languages set status='published' where id='${lang_id}'`)
    // 3c. images 业务列变化（sort_order 位移 1）→ image.updated
    if (img_id) await c.query(`update public.images set sort_order = sort_order + 1 where id='${img_id}'`)
    // 3d. 阴性：语言 no-op update（仅 touch updated_at）→ 不产生 asset_language.updated
    await c.query(`update public.asset_languages set status=status where id='${lang_id}'`)
    // 3e. 阴性：images no-op（sort_order=sort_order）→ 不产生 image.updated
    if (img_id) await c.query(`update public.images set sort_order = sort_order where id='${img_id}'`)

    const act = await c.query(`select action, count(*)::int c from public.audit_logs
      where target_id in ('${lang_id}','${img_id || 0}') and actor_id='${adminId}'
      group by action order by action`)
    const have = Object.fromEntries(act.rows.map((r) => [r.action, r.c]))
    ok('T1 asset_language.published 触发', have['asset_language.published'] >= 1,
      JSON.stringify(have['asset_language.published']))
    ok('T2 asset_language.unpublished 触发', have['asset_language.unpublished'] >= 1,
      JSON.stringify(have['asset_language.unpublished']))
    ok('T3 image.updated 业务列变化触发', !img_id || have['image.updated'] >= 1,
      JSON.stringify(have['image.updated']))
    ok('T4 阴性 no-op 不产生 asset_language.updated', (have['asset_language.updated'] || 0) === 0,
      JSON.stringify(have['asset_language.updated']))
    ok('T5 阴性 no-op 不产生 image.updated 增噪', !img_id || (have['image.updated'] || 0) <= 1,
      `image.updated=${have['image.updated'] || 0}（仅 3c 一次）`)
  } finally {
    await c.query('rollback') // 关键：任何结果都回滚，零生产残留
  }

  // ---------- 4. 回滚后验证零残留 ----------
  const st = await c.query(`select status from public.asset_languages where id='${lang_id}'`)
  ok('T6 ROLLBACK 后语言状态还原 published', st.rows[0]?.status === 'published')
  const after = await c.query(`select count(*)::int c from public.audit_logs
    where target_id in ('${lang_id}','${img_id || 0}') and actor_id='${adminId}'
    and action in ('asset_language.published','asset_language.unpublished','asset_language.updated','image.updated')`)
  ok('T7 ROLLBACK 后审计零残留', after.rows[0].c === 0, `残留=${after.rows[0].c}`)
} finally {
  await c.end()
}
console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
