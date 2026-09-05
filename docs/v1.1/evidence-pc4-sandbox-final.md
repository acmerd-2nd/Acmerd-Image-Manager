  PASS  W0 wrangler dev 就绪
(node:54680) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
  PASS  W0b admin 登录
  PASS  W0c 一次性测试用户就位
  PASS  W0d draft Asset/语言就位 — slug=e2e4mtolr7aw
  PASS  W0e 测试图 ready — 027c059d-65b0-4b18-b81f-3bf89ad7ea25
  PASS  W0e2 测试图2 ready — bac0e856-6a3f-46f0-a5c3-ac04d5cbd4c8
  [diag] raw raw NEVER 200 — last=404 after 421303ms
  FAIL  W0f github raw 传播等待 (img1)
  [diag] raw raw NEVER 200 — last=404 after 422197ms
  FAIL  W0f github raw 传播等待 (img2)
  PASS  W1 未认证单图 401 — status=401
  PASS  W2 未发布图 404（守卫先于扣分） — status=404
  PASS  W2b 未扣分 — bal=0
  PASS  W5p published 就位
  PASS  W3 余额不足 402 — status=402
  PASS  W3b 余额不变 — bal=0
  PASS  W4 Admin Set Balance 5 — status=200
  PASS  W4b 余额=5 — bal=5
  PASS  W5 单图 302 — status=302
  PASS  W5b 余额 5→4 — bal=4
  PASS  W5c ledger 行
  PASS  W5d 同 key 重放 302 + 不重复扣 — status=302 bal=4
  PASS  W7 ZIP 200 — status=200
  PASS  W7b 余额 4→3 — bal=3
  PASS  W7c ZIP ledger
  PASS  W6 ZIP 同 key 异参 409 — status=409
  PASS  W8 ZIP 不足 402 — status=402
  PASS  W8b 余额不变 — bal=0
  PASS  W9 Package 402（cost 15 > 余额 3） — status=402
  PASS  W9b 余额不变 — bal=0
  PASS  W10 toggle unlimited ok
  PASS  W10 unlimited 302 + 不扣分 — status=302 bal=0
  PASS  W11 admin_adjustment 流水

[cleanup]
  PASS  W12a github-delete 闭环
  PASS  W12b 清理零残留（资产/用户） — assets=0 users=0

===== PC-4 SANDBOX: 31 PASS / 2 FAIL =====
