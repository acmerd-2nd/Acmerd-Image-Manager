# Phase 8 · Security Hardening — Design Gate（Owner 裁决版）

> 状态：**APPROVED with one wording adjustment** — Owner 已批准，允许开工（D1–D6 全部 APPROVED，§3 攻击面表述按要求修正）
> 日期：2026-09-03 · Owner 裁决全文见 Appendix B（binding，逐项裁决见 §1）
> 依据：`【总纲】` Phase 8（Security Hardening 五层防线 / Secret / Audit / G8）/ `【分阶段】` Phase 8 / Phase 7 Gate 与实施报告（0006 已上生产）
> 本文件 = Phase 8 开工前报告（Design Gate）。Owner 批准后按 Appendix A 顺序实施，严禁扩大 Scope、严禁重构 Phase 2–7。

> **版本说明（2026-09-03 22:45）**：本文件在 Owner 裁决到达时曾被一次文件同步事故覆盖（原 Gate 正文草稿丢失、磁盘仅剩 Owner 裁决文本）。现已按调研事实与 Owner 逐项裁决重建规范版：正文重建锚定于 Owner 逐字裁决（Appendix B 全文保留），§3 已采用 Owner 修正措辞，并新增 §6.4"公开数据集合不漂移"强制验收项。若重建正文与评审所见草稿存在表述出入，以 Owner 裁决（Appendix A/B）为最终契约。

---

## 0. 一句话定位（Phase 8 不是新功能阶段）

Phase 1–7 已落地五层安全防线（Frontend Guard → Route Guard → API Authorization → Supabase RLS → Storage Policy）及大量权限矩阵、审计触发器（0001/0003/0005/0006）与原子化 last-admin 保护（0006）。
**Phase 8 = Security Hardening 收口**：不加新功能，专门做安全——
1. 补齐调研发现的真实审计盲区（GAP-A / GAP-B）；
2. 顺带修复 pre-existing DEF-1（tags.updated_at，恢复既有改名能力）；
3. Secret 泄漏扫描脚本化 + 证据落档；
4. 产出 **Security Review Passed**（G8 唯一硬性验收）。
不借机重构 Phase 2–7，不引入 5b/5c（Storage 强门控）等范围外提案。

---

## 1. Owner 逐项裁决（binding）

| # | 决策点 | Owner 裁决 | 落点 |
| -- | ------ | ---------- | ---- |
| D1 | Phase 8 形态 | **APPROVED**：Security Hardening + Security Review，不演变成渗透测试项目 | 全 Phase |
| D2 | asset_languages 审计粒度 | **APPROVED（2a）**：`asset_language.created / published / unpublished / updated / deleted` 五种语义分开留痕；published/unpublished 不得被普通 updated 淹没 | 0007 |
| D3 | images UPDATE 审计 | **APPROVED（3a）**：仅在 `filename / sort_order` 等业务列实际变化时记 `image.updated`，用 WHEN 限定，避免 touch `updated_at` 导致审计刷屏 | 0007 |
| D4 | DEF-1 修复时机 | **APPROVED（4a）**：随 0007 顺带修 `tags.updated_at`；migration 与 Security Review 中**明确标记为 pre-existing defect fix**，不视为新增能力 | 0007 + Review |
| D5 | Storage 单图硬门控 | **APPROVED（5a）**：维持 public bucket + Worker 软门控；残余风险必须写进 Security Review；5b/5c 不进入本 Phase | Security Review |
| D6 | Secret 扫描 | **APPROVED（6a）**：`security-scan.mjs` 可复跑，扫描 git 全历史 / dist / 工作区跟踪情况，产出 `evidence/secret-scan.md` | 脚本 + 证据 |
| §3 | 攻击面表述 | **修正后 APPROVED**（见 §4） | 本文件 |

Owner 附加要求（全部采纳，见 §6.4 与 §10）：

1. 本次 0007 涉及 `asset_languages` 可见性状态 → **必须证明"补审计"不改变原有 published 双门控语义**；回归不只要测"有没有 audit row"，还要证明**公开数据集合没有因新增 trigger/function 而漂移**。
2. 0007 是"恢复既有功能 + 补审计"，不是新功能；migration 文件头与 Review 必须留下 pre-existing defect fix 标记。
3. 未提供实际证据前，不得宣布 G8 PASS。

---

## 2. 范围与边界

### Scope（本 Phase 交付）

1. **DB Migration `0007`**（唯一迁移）：GAP-A/GAP-B 审计触发器 + allowlist 扩展 + DEF-1 补列（§6）。
2. **隔离库验证**：一次性库全量应用 0001→0007，含非漂移回归（§10 证据 1/6）。
3. **Secret 扫描**：`scripts/security-scan.mjs` + 运行证据 `docs/phase-8/evidence/secret-scan.md`（§9）。
4. **Security Review 报告**：`docs/phase-8/02-security-review.md`（五层防线逐层结论 + 残余风险声明 + 证据链汇总）。
5. **生产应用 + 线上抽验**（仅隔离库全绿后）。
6. **Git + G8 宣布**：结束报告 `docs/phase-8/03-implementation-report.md`。

### Out of Scope（明确不做）

- 任何新功能 / UX / 性能改动（Phase 9 内容）。
- 重构或改写 Phase 2–7 任何逻辑、RLS 策略、触发器语义（0007 只做"追加审计 + DEF-1 补列"）。
- Storage 5b（private bucket + 签名 URL）/ 5c（防盗链等）——不进入本 Phase，仅在 Review 记录为残余风险与后续提案。
- 渗透测试 / 红队 / 外部扫描（D1：本 Phase 不演变成渗透测试项目）。
- Worker 路由权限修复（wrangler routes 报错属运维权限，Phase 7 已记录，不扩大 Scope 处理）。

---

## 3. 复验矩阵 M1–M7 与分层防线

Phase 8 按 `【分阶段】` 五层防线（Frontend Guard / Route Guard / API Authorization / Supabase RLS / Storage Policy）与"普通 USER 必测清单"组织复验。矩阵行即复验对象：

| # | 场景 | 攻击面方法（按 Owner 修正后 §4） | Phase 8 动作 |
| -- | ---- | -------------------------------- | ------------ |
| M1 | 普通 USER 越权写 Assets（create/update/delete/upload） | UI / Worker API / Supabase 直连 三层 | 复验（Phase 2–7 已证，G8 回归留证） |
| M2 | 普通 USER 改 Tag / Download Source / Role | UI / Worker API / Supabase 直连 三层 | 复验（role 直连 0006 已证 FORBIDDEN） |
| M3 | 非 admin（含 Guest 身份）访问 Admin / 后台端点 | UI / Worker API / Supabase 直连 三层 | 复验 |
| M4 | disabled 用户（含被禁 admin）访问 Admin / API / 直连 | UI / Worker API / Supabase 直连 三层 | 复验（Phase 7 S8 线上 403 已证，回归留证） |
| M5 | Storage 对象直读（public bucket，已知 URL 可 GET） | **非三层可消除项**：按 D5/5a 识别为产品模型残余风险 | Review 记录声明（§7），行为快照留证 |
| M6 | Secret 泄漏（bundle / git 全历史 / 工作区 / 远端） | **专门方法**：security-scan.mjs 脚本化扫描 | 脚本 + evidence（§9） |
| M7 | Audit 完整性（所有重要 Admin 操作留痕；GAP-A/GAP-B 修复） | **专门方法**：触发器回归 + 公开集合快照对比（§6.4） | 0007 + 隔离库用例 |

---

## 4. 攻击面验证方法论（§3 修正措辞，Owner 批准版本）

> 原表述（已废弃）："每一层都要有绕过 UI → 手动 API → 直连 Supabase 三种攻击面下仍然失败"——对所有攻击场景一刀切并不适用（M6 Secret / M7 Audit 完整性不是传统越权）。

**修正后（本 Gate 生效表述）**：

> "对于适用的权限/越权场景（M1–M4），必须分别验证 UI 绕过、Worker/API 直接调用、Supabase 直连三类攻击面；对于 Secret（M6）、Audit Integrity（M7）、安全配置等非访问控制项，采用对应的专门验证方法。"
>
> 不要求 M6 / M7 强行套三层攻击面模型。M5 为产品模型残余风险项，采用行为快照 + Review 声明方式（§7）。

---

## 5. 调研差距分析（Phase 8 的真实增量）

### GAP-A：`asset_languages` 增删改零审计（Phase 3–4 引入，0001–0006 从未覆盖）

- 0001 仅有 `touch_asset_languages_upd`（L163，只刷 updated_at），**无任何审计触发器**。
- 0003/0005/0006 均未补（已 grep 证实）。
- 影响：`asset_languages.status` 是 published_assets 双层可见性的**第二层开关**（第一层 = assets.status），Admin 将语言 draft↔published = 直接改变前台可见边界，却无留痕。
- 修复：0007 补 5 种语义审计（D2=2a）。

### GAP-B：`images` UPDATE 无审计

- 0001 仅 `audit_images_ins(image.uploaded)` / `audit_images_del(image.deleted)`（L191-192），**无 update 触发器**。
- 影响：Admin 图片重排（sort_order）、文件名/路径变更无任何审计。
- 修复：0007 补 `image.updated`，业务列 WHEN 限定（D3=3a）。

### DEF-1：`tags` 缺 `updated_at` 列但既有触发器引用它（pre-existing，0001 引入）

- 0001 L123-129：`tags` 表仅 `id/name/slug/created_at`，**无 updated_at 列**。
- 0001 L165：`touch_tags_upd`（BEFORE UPDATE）调用 `touch_updated_at()` → 写 `new.updated_at = now()` → 对无此列的表，任何 UPDATE 报 `record "new" has no field "updated_at"`。
- 影响：**AdminTagsPage 改名实际不可用**（Phase 7 QA DEF-1 已证，Owner 已裁决进 Backlog → 本 Phase 随 0007 修复）。
- 修复：0007 为 `tags` 补列（历史缺陷修复标记，D4=4a）。

---

## 6. 0007 迁移设计（Key Design）

### 6.1 触发器语义（全部 AFTER 触发器；只读 NEW/OLD + 写 audit_logs，不改业务行）

| 对象 | 触发器 | 动作 | 关键限定 |
| ---- | ------ | ---- | -------- |
| asset_languages | AFTER INSERT | `asset_language.created` | 经 `write_audit()`（is_admin 过滤，同既有模式） |
| asset_languages | AFTER DELETE | `asset_language.deleted` | 同上 |
| asset_languages | AFTER UPDATE OF status（status 变化） | `asset_language.published` / `asset_language.unpublished` | 专用函数，metadata 记 from→to；参照 0003 assets 状态审计先例 |
| asset_languages | AFTER UPDATE（status 未变） | `asset_language.updated` | 业务列（asset_id/language_code）实际变化才记；纯 touch（仅 updated_at 被刷）跳过，防刷屏 |
| images | AFTER UPDATE | `image.updated` | **WHEN 限定**：filename/storage_path/mime_type/file_size/width/height/sort_order 任一 distinct 才触发（D3=3a）；纯 touch updated_at 永不触发 |
| tags | —（DEF-1） | — | 补 `updated_at` 列（回填 created_at → set not null → default now()），恢复 0001 L165/L194 两触发器可用性 |

### 6.2 audit allowlist 扩展（18 → 24）

- 0006 CHECK 约束 18 项 → 0007 重建为 24 项（新增 `image.updated` + 5× `asset_language.*`）。
- DO 块幂等：drop constraint if exists → add 新约束；新枚举是既有 18 项的**严格超集**，生产存量行无越界风险。
- 核对：asset.*7 + image.*3 + tag.*3 + asset.tag_*2 + asset_language.*5 + download_source.updated 1 + user.*3 = 24 ✓

### 6.3 权限与执行通道

- 触发器函数 `security definer`，`set search_path = public`，内部 `if not public.is_admin() then return null`（0006 收紧版：活跃 admin）——与 0003/0005 同模式。
- `asset_languages` 写通道仅活跃 admin（0001 RLS：insert/update/delete 均 `using (is_admin())`）→ 触发器不改变任何写入可否通过的判定，只追加留痕。

### 6.4 公开数据集合不漂移（Owner 强制验收项）

**结构保证（静态）**：0007 只追加 AFTER 审计触发器（写 audit_logs）+ 1 个 DDL（tags 补列）+ 换 allowlist CHECK；不新增/修改任何 SELECT 面（published_assets 视图、search_assets RPC 零改动），不改写资产/语言/图片的 INSERT/UPDATE/DELETE 数据面（无 BEFORE 数据守卫、无 NEW/OLD 篡改）。→ 双层可见性判定（`a.status='published' AND l.status='published'`）在构造上不受影响。

**动态证明（隔离库必测）**：
1. 0001→0006 全量应用后播种固定资产图谱（published 资产 × 多语言含 published/draft 语言、draft 资产、图、标签）→ 以 anon 身份快照 `published_assets` 全行 + 双层可见性计数。
2. 应用 0007 后重跑**同一组 SELECT** → 断言行集合与计数逐字节一致（无漂移）。
3. 再跑可见性状态迁移（语言 draft→published / published→draft；资产 publish）→ 断言前台集合按预期增删（语义正确）**且** audit_logs 出现对应 action 的审计行（created/published/unpublished/updated/deleted 语义分离，无普通 updated 淹没）。
4. 阴性用例：纯 touch/no-op UPDATE（如 `set sort_order = sort_order`）不产生 `image.updated` / `asset_language.updated`（防刷屏验证）。

---

## 7. D5 / 5a — Storage 残余风险声明（必须写进 Security Review 的原文）

> **Security Review 必须明确记录**：
> "Guest 正常浏览要求图片对象公开可读，因此'已知公开 URL 可 GET'属于当前产品模型下的残余风险，而非 Phase 8 阻断缺陷。当前 bucket 为 public，`GET {公开URL}` 不需要任何鉴权；普通 API 鉴权无法消除该面（Guest 浏览本身要求可读）。Phase 8 将本约束明确识别并记录；5b（private bucket + 签名 URL）/ 5c（防盗链）作为后续独立提案，不进入本 Phase。"

---

## 8. D6 / 6a — Secret 扫描设计要求

`scripts/security-scan.mjs`（可复跑）扫描范围：

1. **git 全历史**：所有 commit 的 blob 内容（含已删除文件），检测 `supabase_service_role`/`service_role`/`DATABASE_URL`/`PRIVATE KEY`/通用 JWT 签名/长 hex/base64 密钥等特征。
2. **dist/**：打包产物（含 `.map`）特征扫描——不得出现 service role key / 数据库密码。
3. **工作区跟踪情况**：`.env*` 是否被 git 跟踪、是否在 `.gitignore`；跟踪文件内是否含密钥特征。
4. 产出 `docs/phase-8/evidence/secret-scan.md`（扫描范围、命中 0 / 例外清单、可复跑命令）。

---

## 9. Security Review 报告与 G8 验收

`docs/phase-8/02-security-review.md` 逐层结论：

1. **五层防线**（Frontend Guard / Route Guard / API Authorization / RLS / Storage）逐层：现状结论 + 证据引用（M1–M5）。
2. **Secret 层**（M6）：扫描证据引用。
3. **Audit 层**（M7）：GAP-A/B 修复后全量 action 清单 + 非漂移回归证据。
4. **残余风险声明**：D5/5a 原文（§7）+ 其他非阻断项（如 wrangler route 运维权限、GoTrue 撤销 best-effort 边界）。
5. **DEF-1 修复记录**：标记 pre-existing defect fix（D4 要求）。

**G8 = Security Review Passed**（唯一硬性验收），当且仅当六类证据（§10）全部 CONFIRMED。

---

## 10. 证据要求（六类，同 Phase 7 标准；G8 宣布前置）

| # | 证据 | 形态 |
| -- | ---- | ---- |
| 1 | 实际 SQL | 0007 迁移文件（生产已应用，schema_migrations 记录） |
| 2 | 隔离库验证 | 一次性库 0001→0007 冒烟（含触发器语义用例、allowlist、DEF-1 改名恢复） |
| 3 | **公开集合不漂移回归** | §6.4 快照对比 + 状态迁移语义用例（Owner 强制项） |
| 4 | Secret 扫描 | security-scan.mjs 运行记录 + evidence/secret-scan.md |
| 5 | 权限/越权回归（M1–M5） | 隔离库 + 线上抽验（对照 Phase 7 既有证据链） |
| 6 | 生产应用 + 线上抽验 | migration 应用记录 + 线上 sanity（审计写入链路抽查，若可安全构造） |

**红线**：① 未通过隔离库全绿前不碰生产；② 任何一条证据缺失前不得宣布 G8 PASS；③ 不扩大 Scope / 不重构 Phase 2–7；④ `.env` 值全程不回显不落盘。

---

## 11. 实施顺序（Owner 规定，严格执行）

```
0007（编写）→ 隔离库验证（0001→0007 冒烟 + 非漂移回归）
→ Secret Scan（security-scan.mjs + evidence）
→ Security Review（02-security-review.md）
→ 生产 migration（db-apply 0007，应用后只读 sanity）
→ 线上抽验（仅读/安全构造，避免污染生产数据）
→ Git（commit + push main）
→ Gate G8（结束报告 + 宣布，仅当六类证据全 CONFIRMED）
```

---

## Appendix A. Owner 逐项裁决速查

| 项 | 裁决 | 一句话 |
| -- | ---- | ------ |
| D1 | APPROVED | Security Hardening + Security Review；不做渗透测试项目 |
| D2 | APPROVED（2a） | asset_languages 五种语义分离留痕 |
| D3 | APPROVED（3a） | images UPDATE 业务列 WHEN 限定，防 touch 刷屏 |
| D4 | APPROVED（4a） | DEF-1 随 0007 修复，migration/Review 标记 pre-existing |
| D5 | APPROVED（5a） | public bucket 维持；残余风险写入 Review；5b/5c 不进本 Phase |
| D6 | APPROVED（6a） | security-scan.mjs 脚本化 + evidence/secret-scan.md |
| §3 | 修正后 APPROVED | 三层攻击面仅对适用越权场景；M6/M7 用专门方法 |
| 附加 | — | 补审计不得改变 published 双门控语义 → 公开集合不漂移回归（§6.4/§10#3） |

## Appendix B. Owner 最终裁决原文（verbatim，binding）

```text
Phase 8 Design Gate APPROVED with one wording adjustment.

D1 = APPROVED
D2 = APPROVED，采用 2a：
asset_language.created
asset_language.published
asset_language.unpublished
asset_language.updated
asset_language.deleted

D3 = APPROVED，采用 3a：
images UPDATE 仅在 filename / sort_order 等业务列实际变化时记录 image.updated，使用 WHEN 限定，避免 touch updated_at 导致审计刷屏。

D4 = APPROVED，采用 4a：
0007 顺带修复 pre-existing DEF-1（tags.updated_at），并在 migration / Security Review 中明确标记为历史缺陷修复，不视为新增功能。

D5 = APPROVED，采用 5a：
维持 public bucket + Worker 软门控。
Security Review 必须明确记录：
Guest 正常浏览要求图片对象公开可读，因此"已知公开 URL 可 GET"属于当前产品模型下的残余风险，而非 Phase 8 阻断缺陷。
5b / 5c 不进入本 Phase。

D6 = APPROVED，采用 6a：
security-scan.mjs 可复跑，扫描 git 全历史、dist、工作区跟踪情况，并产出 evidence/secret-scan.md。

另外修改 §3 的攻击面表述：
"对于适用的权限/越权场景，分别验证 UI 绕过、Worker/API 直接调用、Supabase 直连三类攻击面；
Secret、Audit Integrity 等非访问控制项采用对应专门验证方法。"
不要要求 M6/M7 强行套三层攻击面模型。

其余 Design Gate 内容 APPROVED。

开始实施后严格保持：
0007 → 隔离库验证 → Secret Scan → Security Review → 生产 migration → 线上抽验 → Git → Gate G8。
不得扩大 Scope，不得重构 Phase 2–7。
未提供实际证据前不得宣布 G8 PASS。
```

**Owner 附加验收要求（原文摘录）**：

> 这次 0007 虽然看起来只是"审计触发器"，但它已经开始涉及 `asset_languages` 的可见性状态，所以必须证明"补审计"不会改变原有 published 双门控语义。也就是说，最终回归测试里不只是测"有没有 audit row"，还要证明公开数据集合没有因为新增 trigger/function 而漂移。

> **G8 Design Gate：APPROVED，允许开工。**
