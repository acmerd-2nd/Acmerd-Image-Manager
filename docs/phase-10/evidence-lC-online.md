=== Phase 10 · L-C 生产在线 E2E（R2 Auth / R5 Download / R1 抽样）===

--- R2 Auth（真实 signup/login/session/logout）---
  PASS  R2-1 Register（auth/v1/signup，邮箱验证关闭直返 session）→ 200
  PASS  R2-2 Session 刷新（refresh_token grant）→ 200 新 access_token
  PASS  R2-3 Logout → 204
  PASS  R2-4 Logout 后旧 refresh_token 已吊销 → 400（期望 400）
  PASS  R2-5 Login（logout 后重新密码登录）→ 200

--- R5 Download（真实链路）---
  PASS  R5-0 user 读取 published_assets → 1 行
  PASS  R5-0b user 读取 published 语言与图 → 各 1
  PASS  R5-1 Single：/api/downloads/image/:id → 302（软门控）
  PASS  R5-1b 302 跟随 → Storage 对象 200，字节 > 0（856321B，host=ctddbmadywtdufazhwiq.supabase.co）
  PASS  R5-2 ZIP：单图打包 → 200 PK 头字节=856433B
  PASS  R5-2b ZIP Content-Disposition 生效（Worker 直出 200）
  PASS  R5-2c ZIP 空选择 → 拒绝（400）
  PASS  R5-3 None 语义：真实资产 download_sources = 0（0 → 面板无链接态）

--- 临时资产与 Admin 正向操作 ---
  PASS  R1-0 admin 登录 → 200
  PASS  R1-1 admin 经 service 通道建临时资产 → 201
  PASS  R1-2 admin Storage 上传 3/en/e2e10-1.png → 200
  PASS  R1-3 admin 建 image 行 1 → 201
  PASS  R1-2 admin Storage 上传 3/en/e2e10-2.png → 200
  PASS  R1-3 admin 建 image 行 2 → 201
  PASS  R1-4 发布临时资产（带封面）→ 204
  PASS  R5-4 0004 守卫：非白名单 host → 拒绝（400）
  PASS  R5-5 Both 语义：quark+baidu 白名单双源建立 → 201/201
  PASS  R5-6 user 可读临时资产双源（2 → UI 选择器语义数据成立）
  PASS  R5-7 1-direct 语义：删 baidu 源后剩 1（204，count=1）
  PASS  R5-8 Multi：2 图 ZIP → 200 PK 头 356B（1×1 微图合法体积可仅数百字节）
  PASS  R1-5 admin GET /api/admin/users → 200 envelope
  PASS  R1-6 admin GET /api/admin/stats → 200
  PASS  R1-7 admin 提权一次性用户 → 200
  PASS  R1-8 提权落库 role=admin
  PASS  R1-9 降回 user → 200，落库 role=user
  PASS  R1-10 审计抽验：user.role_changed 已落 allowlist 审计

--- cleanup（零残留断言）---
  PASS  LC-Z1 删除临时资产 → 204
  PASS  LC-Z2 删除 Storage 对象 95863dc13/en/e2e10-1.png → 200
  PASS  LC-Z2 删除 Storage 对象 95863dc13/en/e2e10-2.png → 200
  PASS  LC-Z3 删除一次性用户 84b47fc9… → 200
  PASS  LC-Z3 删除一次性用户 bb5dcbc9… → 200
  PASS  LC-Z4 反向查询 assets slug 前缀残留 = 0
  PASS  LC-Z5 反向查询 profiles（按本次 user ids）残留 = 0
  PASS  LC-Z6 反向查询 auth.users 前缀残留 = 0
  PASS  LC-Z7 反向查询 images e2e10 文件名残留 = 0

=== L-C 结果: PASS=40 FAIL=0 ===
