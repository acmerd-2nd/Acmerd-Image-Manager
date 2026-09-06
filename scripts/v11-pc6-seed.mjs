#!/usr/bin/env node
/**
 * V1.1 PC-6 Part B —— Seed 用户 demo01–08 一次性建号（service_role，Owner 2026-09-06 授权执行）
 *
 * 规格（Owner 拍板）：
 *   6b 邮箱：demo01@acmerd.com … demo08@acmerd.com
 *   6c 密码交付：随机强密码只写一次性文件（默认 G:\000000.AIDIJIA\seed-credentials-<ts>.txt），
 *      绝不入 Git / chat / 文档 / 记忆
 *   6e 属性：role='user'、credits=0、unlimited=false、profiles.account_origin='seed'、无 admin
 *
 * 幂等安全：已存在的邮箱跳过建号且**不覆盖/不知晓**其密码（报告中标注 pre-existing）。
 * 触发器 handle_new_user（0001+0010）在 createUser 时自动建 profiles + user_roles('user')
 * + credit_accounts(balance 0, unlimited false)；本脚本只追加 account_origin='seed'。
 *
 * 用法：node scripts/v11-pc6-seed.mjs [--out "G:\\000000.AIDIJIA"]
 * 退出码：0=全部成功（或全部 pre-existing）；1=有失败（部分建号成功时密码文件仍会写出成功项）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInt, randomUUID } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const getEnv = (k) => (envText.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim() ?? null
const SB = getEnv('SUPABASE_URL')
const SVC = getEnv('SUPABASE_SERVICE_ROLE_KEY')
if (!SB || !SVC) { console.error('missing env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(2) }

const argOut = process.argv.indexOf('--out')
const OUT_DIR = argOut > -1 ? process.argv[argOut + 1] : 'G:\\000000.AIDIJIA'

const SEEDS = Array.from({ length: 8 }, (_, i) => `demo${String(i + 1).padStart(2, '0')}@acmerd.com`)
const svcH = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

/** 随机强密码：16 位，保证 数字/大写/小写 各≥1（满足服务端规则：≥8 位且 ≥2 类） */
function genPassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digit = '23456789'
  const all = lower + upper + digit + '-_'
  const pick = (set) => set[randomInt(set.length)]
  const chars = [pick(lower), pick(upper), pick(digit)]
  while (chars.length < 16) chars.push(pick(all))
  // Fisher–Yates 洗牌
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

async function listAllUsers() {
  const map = new Map() // email(lower) -> id
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${SB}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: svcH })
    if (!res.ok) throw new Error('admin users list failed: ' + res.status)
    const js = await res.json()
    const users = js.users || js || []
    for (const u of users) if (u.email) map.set(u.email.toLowerCase(), u.id)
    if (users.length < 1000) break
  }
  return map
}

const rest = (path, init) => fetch(SB + '/rest/v1/' + path, { headers: svcH, ...init })

let okCount = 0, failCount = 0
const results = [] // { email, status: 'created'|'pre-existing'|'failed', id?, password? }

try {
  const existing = await listAllUsers()

  // 1) 建号（幂等：已存在跳过）
  for (const email of SEEDS) {
    if (existing.has(email)) {
      results.push({ email, status: 'pre-existing', id: existing.get(email) })
      console.log('  SKIP  ' + email + ' (pre-existing, password not touched)')
      continue
    }
    const password = genPassword()
    const res = await fetch(`${SB}/auth/v1/admin/users`, {
      method: 'POST', headers: svcH,
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      results.push({ email, status: 'failed', error: res.status + ' ' + body.slice(0, 120) })
      console.log('  FAIL  ' + email + ' — createUser ' + res.status)
      failCount++
      continue
    }
    const u = await res.json()
    results.push({ email, status: 'created', id: u.id, password })
    console.log('  CREATE ' + email)
  }

  // 2) account_origin='seed'（对全部 8 个幂等设置，含 pre-existing）
  for (const r of results) {
    if (!r.id || r.status === 'failed') continue
    const p = await rest('profiles?id=eq.' + r.id, {
      method: 'PATCH',
      body: JSON.stringify({ account_origin: 'seed' }),
    })
    if (!p.ok) {
      r.status = r.status === 'created' ? 'failed(origin)' : r.status
      r.error = 'profiles PATCH ' + p.status
      console.log('  FAIL  ' + r.email + ' — set account_origin ' + p.status)
      if (r.status === 'failed(origin)') failCount++
    }
  }

  // 3) 只读回验：seed=8、role='user'、credit_accounts(0,false)
  const ids = results.filter((r) => r.id).map((r) => r.id)
  const inList = 'in.(' + ids.join(',') + ')'
  const prof = (await (await rest('profiles?id=' + inList + '&select=id,account_origin')).json()) || []
  const roles = (await (await rest('user_roles?user_id=' + inList + '&select=user_id,role')).json()) || []
  const credits = (await (await rest('credit_accounts?user_id=' + inList + '&select=user_id,balance,unlimited')).json()) || []
  const profOk = prof.filter((p) => p.account_origin === 'seed').length
  const roleOk = roles.filter((r) => r.role === 'user').length
  const credOk = credits.filter((c) => Number(c.balance) === 0 && c.unlimited === false).length
  console.log(`  VERIFY profiles seed=${profOk}/${ids.length}  role user=${roleOk}/${ids.length}  credits(0,false)=${credOk}/${ids.length}`)
  if (profOk !== ids.length || roleOk !== ids.length || credOk !== ids.length) failCount++

  // 4) 登录冒烟（仅本轮 created 的账号；pre-existing 不知密码不测）
  let loginOk = 0, loginTried = 0
  for (const r of results) {
    if (r.status !== 'created' || !r.password) continue
    loginTried++
    const lr = await fetch(SB + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: getEnv('SUPABASE_PUBLISHABLE_KEY') ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: r.email, password: r.password }),
    })
    if (lr.ok) loginOk++
    else console.log('  FAIL  login smoke ' + r.email + ' — ' + lr.status)
  }
  if (loginTried > 0) {
    console.log(`  VERIFY login smoke=${loginOk}/${loginTried}`)
    if (loginOk !== loginTried) failCount++
  }

  // 5) 密码文件（仅 created 项；零密码入 chat/git/文档/记忆）
  const created = results.filter((r) => r.status === 'created' && r.password)
  if (created.length > 0) {
    const dir = resolve(OUT_DIR)
    if (!existsSync(dir)) throw new Error('输出目录不存在: ' + dir)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `seed-credentials-${ts}.txt`)
    const lines = [
      'ACMERD Image Manager — V1.1 PC-6 Seed 用户凭据（一次性交付件）',
      '生成时间: ' + new Date().toISOString(),
      '⚠ 请立即转存到你的密码管理器，随后删除本文件。绝不再生成/重发；勿提交到任何仓库。',
      '',
      ...created.map((r) => `${r.email}\t${r.password}`),
      '',
      '注: pre-existing 账号不在本文件中（未触碰其密码）。',
    ]
    writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8' })
    console.log('  CREDENTIALS FILE → ' + file + '  (' + created.length + ' accounts)')
  }

  okCount = results.filter((r) => r.status === 'created' || r.status === 'pre-existing').length
  console.log(`\n===== PC-6 SEED: ${okCount} ready / ${failCount} failed =====`)
  process.exit(failCount === 0 ? 0 : 1)
} catch (e) {
  console.error('FATAL', e instanceof Error ? e.message : e)
  process.exit(1)
}
