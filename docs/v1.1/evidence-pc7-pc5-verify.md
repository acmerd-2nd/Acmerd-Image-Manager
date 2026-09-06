  PASS  V0 wrangler dev 就绪
  PASS  R1 registration_enabled=true 有效注册 200 — status=200
(node:38208) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
  PASS  R1b 用户已由 Worker 建号（admin 列表可见） — id=2df81cc0-dda5-487e-8a82-220d124a8289
  PASS  R1c E2E 登录建立会话（PD-1 方案 A 成立） — status=200
  PASS  R2 弱密码 400 invalid_input — status=400 code=invalid_input
  PASS  R3 非法邮箱 400 invalid_input — status=400 code=invalid_input
  PASS  R4 重复邮箱 400 registration_failed（防枚举） — status=400 code=registration_failed
  PASS  R5 清理零残留（e2e5%pc5.test） — gone

===== PC-5 VERIFY: 8 PASS / 0 FAIL =====
