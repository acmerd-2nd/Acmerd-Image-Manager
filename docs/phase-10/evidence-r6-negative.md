=== Phase 10 · R6 Permission Regression（生产负样本，全部必须 FAIL-EXPECTED）===

--- R6-1 Guest → Admin（无 JWT）---
  PASS  R6-1 GET /api/admin/users → 401（期望 401）
  PASS  R6-1 GET /api/admin/stats → 401（期望 401）
  PASS  R6-1 POST /api/admin/users/{id}/role → 401（期望 401）
  PASS  R6-1 POST /api/admin/users/{id}/disabled → 401（期望 401）
  PASS  R6-1 POST /api/admin/storage/delete → 401（期望 401）

--- R6-2 Guest → DB / Storage ---
  PASS  R6-2a anon INSERT assets → 拒绝（400）
  PASS  R6-2b anon INSERT user_roles → 拒绝（401）
  PASS  R6-2c anon INSERT audit_logs → 拒绝（401）
  PASS  R6-2d anon SELECT audit_logs → 空集（200, 0 行）
  PASS  R6-2e anon Storage 上传 images 桶 → 拒绝（400）

--- 一次性用户创建 ---
  PASS  R6-0a 创建一次性用户 → 200
  PASS  R6-0b 一次性用户登录 → 200

--- R6-3 USER → Admin（非管理员 JWT）---
  PASS  R6-3 GET /api/admin/users → 403（期望 403）
  PASS  R6-3 GET /api/admin/stats → 403（期望 403）
  PASS  R6-3 POST role 提权 → 403（期望 403）
  PASS  R6-3 POST disabled 自保改写 → 403（期望 403）
  PASS  R6-3 POST storage/delete → 403（期望 403）

--- R6-4 USER → DB ---
  PASS  R6-4a user INSERT assets → 拒绝（400）
  PASS  R6-4b user UPDATE 他人 assets → 拒绝（写返回 204，2xx 回读 name before="Ecosonique" after="Ecosonique" 未变
  PASS  R6-4c user INSERT user_roles（自我提权）→ 拒绝（403）
  PASS  R6-4d user INSERT audit_logs → 拒绝（403）
  PASS  R6-4e user SELECT audit_logs → 空集（0 行）
  PASS  R6-4f user 直调 admin_user_mutation RPC → 拒绝（403，函数仅授权 service_role）
  PASS  R6-4g user Storage 上传 images 桶 → 拒绝（400）

--- R6-5 disabled 门禁 ---
  PASS  R6-5a admin 登录 → 200
  PASS  R6-5b admin 禁用一次性用户 → 2xx（200）
  PASS  R6-5c disabled 用户带有效 JWT 打 admin API → 403 account_disabled（403）
  PASS  R6-5d disabled 用户打下载端点 → 403 account_disabled（403）

--- cleanup（零残留断言）---
  PASS  R6-Z1 删除一次性用户 → 200
  PASS  R6-Z2 反向查询 profiles 前缀残留 = 0
  PASS  R6-Z3 反向查询 user_roles 该用户残留 = 0
  PASS  R6-Z4 反向查询 auth.users 前缀残留 = 0

=== R6 结果: PASS=32 FAIL=0 ===
