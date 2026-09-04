# Phase 10 · Full Regression Report（R1–R6 + I1–I4）

> 日期：2026-09-04 · 执行环境：本会话（node 脚本 + agent-browser 真实 Chromium）
> 依据：`docs/phase-10/01-design-gate.md`（Owner APPROVED D1–D5 + 5 附加约束，§7 落档）
> 结果分类：PASS / FAIL-EXPECTED（负样本必须失败，不计为失败）/ N/A / **UNEXPECTED FAIL（唯一阻塞项）**

---

## 一、Release Manifest（约束 #1/#2：RC 冻结 + 身份四要素）

| 要素 | 值 | 核验方式 |
| --- | --- | --- |
| Release Candidate Commit | `131d315`（Phase 10 Gate 提交；含 DEF-9-1 修复 `f72d570`） | `git log` |
| 前端 bundle 身份 | **`index-DosBFCeX.js`**（129.37 kB gzip）；从 RC 树独立重建 hash **逐字节同源** = 线上 HTML 引用 hash | `vite build --outDir dist-rc-check` + curl 生产 HTML |
| Worker 部署身份 | `94cb46b3-c7b4-4c1c-878a-8e1aeb686d27`（2026-09-04T03:21:45Z，100% 流量） | `wrangler deployments list` |
| DB 迁移状态 | 0001–0008 全部 applied（`db:migrate` 幂等全 skip） | `npm run db:migrate` |
| 生产健康（匿名 5 项） | /api/health 200 · / 200 · /search 200 · /asset/ecosonique 200 · /login 200 | curl |

**结论：所有回归均针对同一 commit（`131d315`）+ 同一线上 bundle（`index-DosBFCeX.js`）+ 同一 Worker 版本执行，证据与发布物一致。**

---

## 二、执行总览

| 套件 | 层 | 脚本 | 结果 | 证据日志 |
| --- | --- | --- | --- | --- |
| R6 Permission（负样本） | L-B 生产 | `scripts/phase10-r6-negative.mjs` | **32/32 PASS**（全部 FAIL-EXPECTED 达成） | `evidence-r6-negative.log` |
| R3 Asset + R4 Language + I1–I4 | L-A 隔离库 | `scripts/phase10-isolated-regression.mjs` | **28/28 PASS** | `evidence-lA-isolated.log` |
| R2 Auth + R5 Download + R1 抽样 | L-C 生产在线 | `scripts/phase10-online-e2e.mjs` | **40/40 PASS** | `evidence-lC-online.log` |
| R1 三角色验收走查（UI/映射） | L-B/L-C/G9 | 本报告 §五 映射表 | 全绿 | G9 截图 + 上述日志 |
| 合计 | | | **100/100 PASS · 0 UNEXPECTED FAIL** | |

---

## 三、R6 Permission Regression（五类越权，全部必须失败 → 全部失败）

| # | 越权路径 | 实测 | 判定 |
| --- | --- | --- | --- |
| R6-1 | Guest（无 JWT）→ Worker admin API ×5（users/stats/role/disabled/storage-delete） | 全部 **401** | FAIL-EXPECTED ✅ |
| R6-2a-c | anon → PostgREST 写 assets / user_roles / audit_logs | 400 / 401 / 401 拒绝 | FAIL-EXPECTED ✅ |
| R6-2d/e | anon 读 audit_logs → 空集；anon Storage 上传 images 桶 → 拒绝 | 200+0 行 / 400 | FAIL-EXPECTED ✅ |
| R6-3 | USER（非管理员 JWT）→ Worker admin API ×5 | 全部 **403** | FAIL-EXPECTED ✅ |
| R6-4a | USER INSERT assets → 拒绝 | 400 | FAIL-EXPECTED ✅ |
| R6-4b | USER UPDATE 他人 assets → **204 + 回读 name 未变**（RLS 过滤 0 行，双证模式实证） | 未变 | FAIL-EXPECTED ✅ |
| R6-4c/d | USER 自我提权 INSERT user_roles / INSERT audit_logs | 403 / 403 | FAIL-EXPECTED ✅ |
| R6-4e/f | USER 读 audit_logs → 空集；直调 admin_user_mutation RPC → 拒绝（仅授权 service_role） | 0 行 / 403 | FAIL-EXPECTED ✅ |
| R6-4g | USER Storage 直写 images 桶 → 拒绝 | 400 | FAIL-EXPECTED ✅ |
| R6-5 | disabled 门禁发布复验：admin 禁用一次性用户 → 其**有效 JWT** 打 admin API / 下载端点 | **403 `account_disabled`** ×2 | FAIL-EXPECTED ✅ |
| R6-Z | 清理 + 反向查询（profiles/user_roles/auth.users） | 0 残留 ×3 | PASS ✅ |

## 四、L-A 隔离库（一次性库 0001→0008，finally DROP）

**R3 Asset（12/12）**：Create ✅ Edit 回读 ✅ **PUBLISH_BLOCKED 守卫**（无 published 语言+图发布被拒）✅ Publish ✅ **COVER_MISMATCH 守卫**（跨资产封面被拒）✅ Cover 设置 ✅ Unpublish 后 guest 不可见 ✅ Archive 不可见 ✅ **Restore（archived→draft，产品真实语义）** ✅ 重发布可见 ✅ 审计四语义（published/unpublished/archived/restored）全留痕且在 allowlist ✅ user 写旁路 0 行 ✅ Delete 级联清零（langs=0/images=0）✅

**R4 Language（9/9）**：en/de/it/fr/es 五语言创建 ✅ 非法码 `zh` CHECK 拒绝 ✅ 重复 (asset,language) unique 拒绝 ✅ 双层可见性 language_count=1 → Switch 增至 3 → Unpublish 回 2 ✅ draft 语言图不计入 guest image_count ✅ 语言审计三语义（created/published/unpublished）✅ user 写旁路 ✅

**I1–I4 发布复验**：I1a 签名保持 ✅ I1b/I3 NO-DRIFT（基线取在 0008 应用前一刻，drift=0）✅ I2 并集=全量无重复（10=10）✅ I2a 顺序一致 ✅ I4 anon 只见 published（10=10，无 draft 泄漏）✅

## 五、L-C 生产在线 E2E（真实域名/Worker/Supabase/CDN/对象存储链路）

**R2 Auth（5/5）**：Register（signup 直返 session）✅ Session 刷新（refresh grant）✅ Logout 204 ✅ **Logout 后旧 refresh_token 吊销（400）** ✅ 重新登录 ✅

**R5 Download（9/9）**：Single 302 软门控 ✅ 跟随→Storage 200（856,321B 真实原图）✅ ZIP 单图 200 PK 头（856,433B）✅ Content-Disposition 生效 ✅ 空选择 400 ✅ **None 语义**（真实资产 0 源）✅ **0004 host 守卫**（evil.example.com → 400 拒绝）✅ **Both 语义**（quark+baidu 双源 → UI 选择器数据成立）✅ **1-direct 语义**（删一源剩 1）✅ **Multi 2 图 ZIP** 200 PK ✅

**R1 Admin 正向（6/6）**：临时资产创建/发布（带封面+双图）✅ Storage 上传 ✅ /api/admin/users envelope ✅ /api/admin/stats ✅ **提权→落库 admin→降回 user 全链**（Worker→admin_user_mutation→审计）✅ `user.role_changed` 审计落 allowlist ✅

**清理与零残留（8/8）**：临时资产/2 Storage 对象/2 一次性用户删除 ✅ + **反向查询** assets slug 前缀 / profiles 按_ids / auth.users 前缀 / images 文件名 = 全 0 ✅

## 六、R1 三角色验收映射（总纲 §55 → 证据源）

| 角色 | 验收项 | 证据 |
| --- | --- | --- |
| Guest | 可浏览/搜索/详情/切语言 | G9 三视口截图（home/search/detail 200）+ R6-2（负样本全拒）+ R4（语言语义 L-A）+ G4 证据 |
| Guest | 不能进 Admin | R6-1（admin API 全 401）+ RequireRole guard（G9 登录重定向实测） |
| Guest | 不能下载 | UI 层：详情页"下载需登录"文案（G9 截图）；API 层为 D5/5a 既定软门控模型（Phase 8 冻结残余风险，非本 Phase 变更项） |
| USER | 注册/登录/登出/会话 | R2-1~5 |
| USER | 可浏览/搜索/详情/切语言/单图/多选/Package | R5-0~8 + G9 USER 视口截图 |
| USER | 不能编辑/上传/删除/进 Admin | R6-3/R6-4 全绿（403/拒绝/0 行） |
| ADMIN | 进 Admin/管理 Asset/上传/封面/语言/Tag/源/User/Audit | R1-1~10（正向全链）+ G9 Admin 视口截图 + L-A R3/R4（管理语义） |

**Reset Password（R2-6）= N/A**（Owner 裁决 D3：未实现不补开发，Release Notes 披露）。
**ZIP >30 图 / >100MB 限额**：生产数据量不足以自然触发（1–2 图），语义由 Phase 5 QA 16/16 证据覆盖（Worker 代码自 Phase 5 零变更，本次 R5-2c 空选择拒绝复验门控行为）。

## 七、DEF-10-x 台账

**产品缺陷：0 个。** 回归期间无 UNEXPECTED FAIL。

脚本侧缺陷（不影响产品，如实记录）：
1. 初版 R6 脚本用例排序错误（R6-5 先于用户创建执行）→ 修正重跑 32/32。
2. L-C 脚本 signup 返回结构误读（`body.id` vs `body.user.id`）→ 首轮遗留 1 个注册残留用户；**反向查询断言（Owner 约束 #1）当场捕获** → 立即删除复核归零 → 修正后全套重跑 40/40。此事件反向证明了"反向查询 0 残留"约束的有效性。

## 八、生产健康终检（约束 #3，发布后复验见 03-release-notes）

见 Release Manifest §一（5 项匿名 200 + bundle 身份一致）+ R1-5/6（admin session 维度 users/stats 200）+ G9 证据（Admin Console 7 页 admin 登录态渲染正常）。

---

## 九、Gate G10 判据核对

```text
R1–R6 全绿（负样本全部 FAIL-EXPECTED）        ✅
I1–I4 发布复验 PASS                            ✅
N/A 仅限 D3（Reset Password）                  ✅
UNEXPECTED FAIL = 0                            ✅
零残留反向查询全 0                             ✅
Release Manifest 四要素齐备                    ✅
→ 满足进入 Release 动作（tag v1.0.0）的条件
```
