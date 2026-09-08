// V1.3.1 生产 RPC 实测：adjust_credits + admin_batch_adjust_credits
// 全程单事务 + ROLLBACK —— 零残留。余额用"设定为当前值"双保险。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await c.connect()

// 找一名真实管理员
const admin = (await c.query(`select ur.user_id id from public.user_roles ur where ur.role='admin' order by ur.user_id limit 1`)).rows[0]
if (!admin) throw new Error('no admin profile found')
const AID = admin.id

const before = (await c.query(`select balance from public.credit_accounts where user_id=$1`, [AID])).rows[0].balance
console.log(`admin=${AID} balance_before=${before}`)

await c.query('begin')
try {
  // 模拟 service_role 调用（事务级 claim）
  await c.query(`select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)`)

  // 1) adjust_credits（set_balance 语义，设定为当前值 → amount=0 流水）
  const r1 = await c.query(`select public.adjust_credits($1::uuid, $2::numeric, 'prod-regression-set', $1::uuid, 'set_balance') r`, [AID, before])
  console.log('adjust_credits ->', JSON.stringify(r1.rows[0].r))

  // 2) admin_batch_adjust_credits（+3，事务内可见、ROLLBACK 后消失）
  const r2 = await c.query(`select public.admin_batch_adjust_credits(array[$1::uuid], 3, 'prod-regression-batch', $1::uuid) r`, [AID])
  console.log('batch(+3) ->', JSON.stringify(r2.rows[0].r))
  const mid = (await c.query(`select balance from public.credit_accounts where user_id=$1`, [AID])).rows[0].balance
  console.log(`balance_in_txn=${mid} (expect ${before}+3)`)

  const led = await c.query(
    `select type, amount, balance_after, metadata->>'operation' op from public.credit_transactions
     where user_id=$1 and created_at > now() - interval '1 minute' order by created_at desc`, [AID])
  console.log('ledger rows in txn:', led.rows.map((r) => `${r.type}/${r.amount}/${r.balance_after}/${r.op}`).join(' | '))
} finally {
  await c.query('rollback')
}

const after = (await c.query(`select balance from public.credit_accounts where user_id=$1`, [AID])).rows[0].balance
const residue = await c.query(
  `select count(*) n from public.credit_transactions where user_id=$1 and created_at > now() - interval '1 minute'`, [AID])
console.log(`balance_after_rollback=${after} (expect ${before})  residue_txns=${residue.rows[0].n} (expect 0)`)
const ok = Number(after) === Number(before) && residue.rows[0].n === '0'
console.log(ok ? 'RPC PROD TEST: ALL PASS (rolled back, zero residue)' : 'RPC PROD TEST: FAILED')
await c.end()
process.exit(ok ? 0 : 1)
