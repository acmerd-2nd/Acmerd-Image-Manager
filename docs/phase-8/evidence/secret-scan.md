# Phase 8 · Secret 扫描证据（D6/6a）

- 日期：2026-09-03
- 脚本：`scripts/security-scan.mjs`（可复跑，`node scripts/security-scan.mjs`）
- 依据：Owner 裁决 D6 = APPROVED（6a：脚本化 + 证据落档，扫描 git 全历史、dist、工作区跟踪情况）

## 扫描面与规则

| 面 | 范围 | 规则 |
|---|---|---|
| git 全历史 | `git rev-list --objects --all` 全部唯一 blob（text 237 个） | service_role JWT（eyJ… 解码 payload 含 service_role）、DB 连接串含密码、`PRIVATE KEY` 块、常见密钥变量名赋值；`.env.example`/`sample`/`template`/`dist` 中的占位模板豁免为 SAMPLES |
| dist/ 产物 | `dist/` 全文件（含 assets/*.js/map） | 同上 |
| 工作区跟踪 | `git ls-files` 全部 `.env*`；`.env`/`.env.local`/`.env.production` 忽略状态 | 跟踪的 .env*（example/sample 豁免）；存在但未被 gitignore 的 .env |
| 跟踪内容 | `git ls-files` 全部文本文件逐行 | 敏感变量赋值（同上规则；注释即值/整行注释视为空值豁免） |

## 结果

```
[scan-1] git 全历史唯一 blob
  blobs scanned(text)=237
[scan-2] dist/ 产物
[scan-3] .env* 跟踪/忽略状态
  tracked .env* files: .env.example (example/sample/template 豁免)
  .env: exists, ignored=true
[scan-4] 跟踪文件内容敏感变量赋值

========== RESULT ==========
SECRETS: 0
SAMPLES(placeholder, 豁免): 0
SCAN_EXIT=0
```

- **SECRETS = 0**：git 全历史 237 个文本 blob、dist 产物、工作区跟踪文件均无密钥泄漏。
- `.env.example` 为占位模板（值均为空/注释），豁免不计。
- 本地 `.env` 存在但 `ignored=true`（已被 .gitignore 覆盖），从未提交（git 历史无 `.env` blob）。

## 阳性对照（证明扫描器检出能力，非空转）

一次性临时分支 `_scan_posctrl` 提交含伪造密钥的文件，扫描结果：

```
[git-history] _posctrl_leak.txt :: database_url=post***es
[git-history] _posctrl_leak.txt :: db-conn-with-password (pwd Posc***45)
[git-history] _posctrl_leak.txt :: private-key
[tracked]     _posctrl_leak.txt :: service_role_key=eyjh***bb
[tracked]     _posctrl_leak.txt :: database_url=post***es
[tracked]     _posctrl_leak.txt :: db-conn-with-password (pwd Posc***45)
[tracked]     _posctrl_leak.txt :: private-key
```

即：service_role JWT 赋值、DB 连接串含密码、私钥块均可被检出（输出按命中掩码脱敏）。删除临时分支后复扫 **SECRETS = 0 / EXIT=0**，确认当前仓库无真实泄漏。

## 结论

**Secret 层（M6）PASS**：可复跑脚本化扫描覆盖 git 全历史 + dist + 工作区三面，零真实命中，阳性对照证明检出能力有效。
