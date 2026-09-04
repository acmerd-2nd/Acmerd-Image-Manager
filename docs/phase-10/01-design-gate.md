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
