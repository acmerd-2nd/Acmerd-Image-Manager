# Phase 10 · Production Release — Design Gate（PENDING OWNER REVIEW）

> 文档性质：**设计门禁**（Design-first，本文件获批前不执行回归、不做发布动作）
> 编制：主理人（Agent） · 日期：2026-09-04
> 依据：`【分阶段】acmerdImage-manager.md` Phase 10（L1084–1171）+ Gate G10（L1174–1193）+ §55 用户验收清单（总纲 L2006–2051）；`【总纲】acmerdImage-manager.md` Phase 10（L1966–1981）+ §54 V1.0 禁做清单
> 前置：Phase 0–9 全 CLOSED（G0–G9 PASS，G9 于 2026-09-04 关闭，见 `docs/phase-9/03-g9-closure-report.md`）

---

## 1. 定位与范围红线

Phase 10 = **V1.0 发布阶段：全量回归验证 + 发布**。规划原文「这一阶段不再新增产品功能。只做：Release Candidate + Full Regression」。

**范围红线**
- **零新功能、零重构、零 DB/Worker/前端代码变更**（DEF-9-1 式缺陷修复除外——若回归中发现真实缺陷，按「精准最小修复 + 局部验证」处理并单独报备，重跑受影响用例，不扩大）。
- 不触碰冻结基础设施：published_assets / is_admin() / RLS / audit allowlist(24) / disabled 门禁 / 多语言双层可见性。
- 回归中发现"规划列出但从未实现"的能力（如 Reset Password，见 D3），**一律不补开发**，只做裁决记录（N/A 或记入 V1.x backlog）。
- V1.0 禁做清单（总纲 §54）继续有效：用户上传/编辑、付费、AI Tag、评论点赞、社交、复杂推荐、团队协作。

---

## 2. 现状基线（回归的起点事实，只读核实）

| 维度 | 事实 | 对回归的影响 |
| --- | --- | --- |
| 生产数据 | 1 asset（ecosonique，published）/ 1 image / 0 tags / 1 user（admin）/ 23 storage objects | 写路径回归不能依赖生产小数据集充当多语言/多状态场景 → 用一次性实体造数（D1） |
| 语言模型 | `language_code in ('en','de','it','fr','es')`（0001 CHECK） | Language Regression 五语言 + Draft/Published/Switch 全部可执行 |
| 下载源 | provider `'quark' \| 'baidu'` + host 白名单（pan.quark.cn / pan.baidu.com / yun.baidu.com）（0004 + validators.ts） | Download Regression 的 Quark/Baidu/Both/None 语义已实现，可执行 |
| Reset Password | **代码中不存在**（src 全树无 resetPassword/recover/forgot） | Auth Regression 五项中此项无实现 → D3 裁决 N/A |
| 既有可复用资产 | `scripts/phase7-online-e2e.mjs`（一次性用户 + finally 清理 + 级联零残留）、`scripts/phase8-isolated-smoke.mjs`（一次性库范式）、`scripts/phase8-prod-spotcheck.mjs`（ROLLBACK 抽查范式）、agent-browser 真实浏览器 QA（Phase 9 第④类已验证） | 回归不重造轮子，扩用既有范式 |

---

## 3. 设计决策 D1–D5（请逐项裁决）

### D1 回归执行环境与数据策略（核心决策）

**建议 1a：三层混合**（各层用已验证范式，各场景落在最能证明它的层）：

| 层 | 环境 | 覆盖内容 | 残留政策 |
| --- | --- | --- | --- |
| L-A 隔离库 | 一次性库 0001→0008 全量（phase8 范式） | Asset 生命周期写路径（Create/Edit/Publish/Archive/Delete/Cover）、语言五语言 Draft/Published/Switch、ZIP 限额语义、**I1–I4 不变量复验**（发布回归必须重证一次） | finally DROP，零残留 |
| L-B 生产负样本 | 生产（只读 + ROLLBACK + 401/403 断言） | Permission Regression 全部负样本（Guest→Admin / USER→Admin / USER→API / USER→Storage / USER→DB Mutation，**全部必须失败**——回读验证 + 状态码双证）、Guest 只读验收、disabled 门禁 | 零写入（负样本天然无残留） |
| L-C 生产在线 E2E | 生产 + 一次性实体（phase7 范式 + agent-browser） | Auth（Register/Login/Logout/Session）、真实下载链路（单图 blob 文件名、ZIP 200、Package 链接）、Admin 正向操作抽样（一次性实体上）、§55 三角色验收走查 | `e2e10-` 前缀 + finally 清理 + 级联零残留断言；审计日志留存属审计记录非残留 |

- 1b 全部在生产真实数据上跑（写路径污染生产 + Cover/Publish 守卫互斥难造数）——不采纳。
- 1c 全部在隔离库跑（证明不了线上部署链路与 CDN/域名/Worker 生产配置）——不采纳。

### D2 浏览器级 E2E 工具

- **2a（建议）复用 agent-browser**：Phase 9 第④类已在同环境验证可行（真实 Chromium、视口/截图/登录态/交互）。零项目依赖。UI 层走查 + L-C 在线 E2E 用它；API/DB 层用 node 脚本。
- 2b 引入 Playwright——与 Phase 9 裁决精神冲突，不采纳。

### D3 Auth Regression 的「Reset Password」处置

- **3a（建议）记 N/A**：产品从未实现（V1.0 范围外）。注册直返 session（邮箱验证开关已关闭）。Auth 回归实际执行 Register/Login/Logout/Session 四项 + `?next=` 白名单防开放重定向。N/A 记录进回归矩阵并在发布说明披露。
- 3b Phase 10 补开发——违反"不新增功能"红线，不采纳。

### D4 V1.0 RELEASE 形态

- **4a（建议）**：回归全绿后——① `git tag v1.0.0`（annotated，指向 release commit）+ push tag + `git ls-remote` 复核 `refs/tags/v1.0.0`；② `docs/phase-10/03-release-notes.md`（版本摘要：Phase 0–9 能力清单、已知残余风险 D5/5a、验收口径）；③ HANDOVER 终版（V1.0 状态 + 运维交接项：CF token routes 权限补齐等运维项）；④ 生产健康终检（/api/health、bundle 哈希、核心页 200）。GitHub Release 页面（Web UI）由 Owner 可选自行发布（沙箱无 gh CLI）。
- 4b 只发 tag 不出文档——不符合证据纪律，不采纳。

### D5 回归用例矩阵与证据分类（Gate G10 判据）

**六套回归 → 执行矩阵**（逐条记录 PASS / FAIL-EXPECTED（负样本必须失败）/ N/A）：

| # | 套件 | 规划条目 | 执行层 | 预估用例 |
| --- | --- | --- | --- | --- |
| R1 | Full Regression（三角色） | Guest/User/Admin 角色验收（总纲 §55 全清单走查） | L-B + L-C | ~30 |
| R2 | Auth Regression | Register/Login/Logout/Session/Reset Password | L-C | ~12（Reset=N/A） |
| R3 | Asset Regression | Create/Edit/Publish/Archive/Delete/Cover | L-A（写路径）+ L-C（抽样） | ~15 |
| R4 | Language Regression | EN/DE/IT/FR/ES × Draft/Published/Switch | L-A + L-C（切换 UX） | ~12 |
| R5 | Download Regression | Single/Multi/ZIP/Quark/Baidu/Both/None | L-C（真实链路）+ L-A（限额语义） | ~12 |
| R6 | Permission Regression | 五类越权**全部必须失败** | L-B（双证：状态码 + 回读） | ~10 |

**G10 判据（建议）**：R1–R6 全绿（负样本全部 FAIL-EXPECTED、无意外 FAIL、N/A 仅限 D3）+ I1–I4 发布复验 PASS + 发布产物证据（tag ls-remote + release notes + 健康终检）→ **G10 PASS → V1.0 RELEASE**。

**证据落档**：`docs/phase-10/`：01-design-gate.md（本文件）→ 02-regression-report.md（R1–R6 逐条矩阵）→ 03-release-notes.md；evidence/（截图、脚本输出、清理零残留断言）。

---

## 4. 改动面汇总

| 层 | 改动 |
| --- | --- |
| DB / Worker / 前端代码 | **零改动**（DEF-9-1 式缺陷除外，单独报备） |
| 新增文件 | `docs/phase-10/`（gate/regression/release notes）、`scripts/phase10-*.mjs`（回归脚本，复用既有范式）、evidence 截图 |
| Git | tag `v1.0.0`（D4） |

## 5. 安全边界影响分析

回归本身**只读 + 负样本 + 一次性实体**，不触碰 G8 冻结基线；Permission Regression 恰恰是对五层防线（RLS / Worker 门禁 / 审计 / Secret / Admin RPC）的发布前复证。生产写操作仅限：一次性实体生命周期（清理到位）与审计日志自然留存。I1–I4 在隔离库发布复验，确保 0008 后无漂移的结论在 release commit 上仍成立。

## 6. 风险与边界

- 生产 E2E 造数用真实 Supabase Auth 注册一次性用户（`e2e10-` 前缀邮箱）→ finally 按 phase7 范式清理（auth.users + profiles 级联断言零残留）。
- 下载回归消耗真实流量/对象读取，量级极小（1 asset / ≤30 图 ZIP 上限内）。
- Cover/Publish 守卫互斥语义在隔离库造数验证，不动生产真实 asset。

---

## 7. Owner 裁决（已落档 · 2026-09-04）

```text
Phase 10 Design Gate APPROVED. D1–D5 全部批准。进入 Full Regression。

D1 = 1a 三层混合验证（隔离库写路径 / 生产负样本 / 生产 E2E）。
     生产写操作严格限于一次性测试实体；finally 清理 + 零残留断言必须保留；
     测试数据必须带明显前缀，回归结束后反向查询确认 0 残留（不只是"删除 API 返回成功"）。

D2 = 2a agent-browser（真实 Chromium），不引入 Playwright，工具链保持稳定。

D3 = 3a Reset Password = N/A，不补开发；回归矩阵记 N/A；
     Release Notes 明示 "Reset Password is not included in V1.0."

D4 = 4a 完整执行 release commit → annotated v1.0.0 tag → push tag →
     git ls-remote → release notes → production health check。
     v1.0.0 必须指向最终 Release Commit（若回归期间出现 DEF-10-x 最小修复：
     修复 → 局部验证 → 受影响套件重跑 → 最终 release commit → tag；不得先 tag 再修）。

D5 = 批准 R1–R6 + I1–I4 全量回归矩阵。
     负样本使用 FAIL-EXPECTED 分类，不计为失败；
     结果分类 = PASS / FAIL-EXPECTED / N/A / UNEXPECTED FAIL，仅最后一种阻塞发布。

Additional release constraints（Owner 补充，直接并入本 Phase，不重开 Gate）：
1. 正式回归前定义并冻结 Release Candidate / Release Commit（所有回归针对同一 commit/bundle）。
2. 发布证据记录完整 Release Manifest：Git SHA、前端 bundle hash、Worker 部署身份、迁移状态。
3. 生产健康验证必须覆盖 /api/health、Home、/search、/asset/:slug、/login、/admin（admin session），
   并核验线上 bundle hash == Release Commit 对应构建产物。
4. 回归中发现真实缺陷 → DEF-10-x 编号 → 精准最小修复 → 局部验证 → 受影响套件重跑；禁止顺手重构。
5. 全部证据归档且最终 release commit 冻结前，不得宣布 V1.0。
```

**批准人**：Owner · **批准日期**：2026-09-04 · **状态**：APPROVED，进入 Full Regression。

---

## 8. G10 最终裁决与收口记录（Owner，2026-09-04）

**G10 = PASS。Phase 10 = CLOSED。V1.0.0 = RELEASED。** Owner 未发现任何阻断发布事项，完整闭环达成：

```text
Phase 0–9 Build the System → Phase 10 Prove the System
R1–R6 全量回归 + I1–I4 不变量复验
→ 100/100 PASS（R6 32/32 · L-A 28/28 · L-C 40/40 · Unexpected Failure 0）
→ Release Commit → v1.0.0 → 线上健康终检 7/7
```

- **Reset Password 处理获认可**：Register ✅ / Login ✅ / Session ✅ / Logout ✅ / Reset Password N/A——未因进入 Release 违反"不新增功能"原则。
- **V1.x backlog 作为发布档案长期记录**（不阻塞 v1.0.0，后续走新 Change Proposal / Phase）：密码找回、单图硬下载门控、更进一步下载安全策略 / keyset、Wrangler Workers Routes 权限。
- **Release Governance 确认（已成立）**：最终 tag `v1.0.0` 指向 `2065d44`，而非最初冻结的 RC `131d315`——**允许**，因 RC 之后仅证据/文档/报告等非运行时代码变更；最终运行代码与 RC 一致，由 bundle hash（`index-DosBFCeX.js` 重建同源）+ Worker identity（`94cb46b3`）+ 迁移状态（0001–0008）对应证明，Owner 接受此发布链。

**收口声明（Owner 原文）**：
> V1.0.0 is the frozen production release. Any post-release change must go through Change Proposal / new phase rather than modifying the release baseline in place.
