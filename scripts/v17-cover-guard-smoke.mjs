// V1.7.0 预授权冒烟：合集封面端点的鉴权/校验/未找到护栏（均在任何 GitHub/DB 写入之前返回，零副作用）
const BASE = 'http://127.0.0.1:8787'
const { readFileSync } = await import('node:fs')
for (const f of ['.env', '.dev.vars']) {
  for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const U = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_PUBLISHABLE_KEY
const jwt = (await (await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) })).json()).access_token
const AUTH = { Authorization: `Bearer ${jwt}` }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const form = (field, type, bytes, name = 'x') => { const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name); return fd }
const post = (path, headers, body) => fetch(`${BASE}${path}`, { method: 'POST', headers, body })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  PASS ', name) } else { fail++; console.log('  FAIL ', name, detail) } }

const RID = crypto.randomUUID() // 随机（不存在）uuid

// 1 无鉴权上传
let r = await post(`/api/admin/collections/${RID}/cover`, {}, form('file', 'image/png', PNG))
ok('C1 无 token → 401/403', r.status === 401 || r.status === 403, `status=${r.status}`)

// 2 非法 collection id
r = await post(`/api/admin/collections/not-a-uuid/cover`, AUTH, form('file', 'image/png', PNG))
ok('C2 非法 id → 400', r.status === 400, `status=${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`)

// 3 不支持 MIME（在任何写入前）
r = await post(`/api/admin/collections/${RID}/cover`, AUTH, form('file', 'text/plain', Buffer.from('hi'), 'a.txt'))
ok('C3 非图片 MIME → 400 Unsupported', r.status === 400 && /Unsupported type/.test((await r.json().catch(() => ({})))?.error?.message ?? ''), `status=${r.status}`)

// 4 超过 5MB（在任何写入前）
r = await post(`/api/admin/collections/${RID}/cover`, AUTH, form('file', 'image/png', new Uint8Array(5 * 1024 * 1024 + 1)))
ok('C4 >5MB → 413 too large', r.status === 413 || (r.status === 400 && /too large/i.test((await r.json().catch(() => ({})))?.error?.message ?? '')), `status=${r.status}`)

// 5 合法小图 + 不存在合集 → 404（fetchCollectionRow 护栏，先于 GitHub 写）
r = await post(`/api/admin/collections/${RID}/cover`, AUTH, form('file', 'image/png', PNG, 'c.png'))
ok('C5 不存在合集 → 404 not_found（未触 GitHub）', r.status === 404, `status=${r.status} ${JSON.stringify(await r.json().catch(() => null))}`)

// 6 DELETE 无鉴权
r = await fetch(`${BASE}/api/admin/collections/${RID}/cover`, { method: 'DELETE' })
ok('C6 DELETE 无 token → 401/403', r.status === 401 || r.status === 403, `status=${r.status}`)

// 7 DELETE 不存在合集 → 404
r = await fetch(`${BASE}/api/admin/collections/${RID}/cover`, { method: 'DELETE', headers: AUTH })
ok('C7 DELETE 不存在合集 → 404', r.status === 404, `status=${r.status}`)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
