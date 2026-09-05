  PASS  W0 wrangler dev 就绪
  PASS  W0b admin 登录
  PASS  W0c 一次性测试用户就位
  PASS  W0d draft Asset/语言就位 — slug=e2e4mtoe6h28
  PASS  W0e 测试图 ready — 797370c7-7e4a-4392-ba6b-44daa20c52a7
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
[debug] zip body: {"error":{"code":"storage_error","message":"Some files are unavailable"}}
  FAIL  W7 ZIP 200 — status=502
  FAIL  W7b 余额 4→3 — bal=4
  FAIL  W7c ZIP ledger
[debug] zip w6 body: {"error":{"code":"bad_request","message":"Some images do not belong to this language"}}
  FAIL  W6 ZIP 同 key 异参 409 — status=400
  FAIL  W8 ZIP 不足 402 — status=400
  FAIL  W8b 余额不变 — bal=4
  PASS  W9 Package 402（cost 15 > 余额 3） — status=402
  FAIL  W9b 余额不变 — bal=4
  PASS  W10 toggle unlimited ok
  PASS  W10 unlimited 302 + 不扣分 — status=302 bal=4
  PASS  W11 admin_adjustment 流水

[cleanup]
  PASS  W12a github-delete 闭环
  PASS  W12b 清理零残留（资产/用户） — assets=0 users=0

===== PC-4 SANDBOX: 23 PASS / 7 FAIL =====
