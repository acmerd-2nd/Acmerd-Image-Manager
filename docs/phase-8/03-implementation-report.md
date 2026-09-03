# Phase 8 · Security Hardening — Implementation Report（结束报告）

> 状态：**G8 PASS**（六类证据全部 CONFIRMED，见 §6）
> 日期：2026-09-03 · Owner 裁决：`docs/phase-8/01-design-gate.md` Appendix B（D1–D6 APPROVED，§3 措辞修正后 APPROVED）
> 实施顺序（Owner 规定）：0007 → 隔离库验证 → Secret Scan → Security Review → 生产 migration → 线上抽验 → Git → Gate G8

---

## 1. 交付总览

Phase 8 = Security Hardening 收口（不加新功能、不重构 Phase 2–7）。实际交付：

| # | 交付物 | 说明 |
| -- | ------ | ---- |
| 1 | `supabase/migrations/0007_audit_hardening.sql`（**生产已应用**） | GAP-A（asset_languages 五语义审计）+ GAP-B（images UPDATE WHEN 限定）+ allowlist 18→24 + **DEF-1 修复（pre-existing defect fix 标记）** |
| 2 | `scripts/phase8-isolated-smoke.mjs` | 可复跑隔离库冒烟（一次性库 0001→0007 + NO-DRIFT + 触发器语义 + DEF-1 对照） |
| 3 | `scripts/security-scan.mjs` | 可复跑 Secret 扫描（git 全历史 / dist / 工作区跟踪） |
| 4 | `scripts/phase8-prod-spotcheck.mjs` | 可复跑生产只读 + 安全构造抽查（自带 ROLLBACK 红线） |
| 5 | 证据四件套 | `evidence/isolated-smoke.md`、`evidence/secret-scan.md`、`evidence/production-apply.md`、`02-security-review.md` |
| 6 | `docs/phase-8/03-implementation-report.md`（本文件） | 结束报告 + G8 宣布 |

**未扩大 Scope**：无前端改动、无 Worker 改动、无 Phase 2–7 逻辑重构；Storage 5b/5c、wrangler 运维权限修复均明确不进入本 Phase。

## 2. 0007 迁移要点（Key Design → 落地）

- **GAP-A（Owner D2=2a）**：`asset_languages` 补 4 个 AFTER 审计触发器，五种语义独立留痕——`created`(INSERT) / `deleted`(DELETE) / `published`(draft→published) / `unpublished`(published→draft) / `updated`(status 未变 + 业务列实际变化)。published/unpublished 是 published_assets 双层可见性第二层开关，与普通 updated 语义分离。
- **GAP-B（Owner D3=3a）**：`images` 补 `audit_images_upd`，WHEN 限定 `filename/storage_path/mime_type/file_size/width/height/sort_order` 任一 distinct 才记 `image.updated`；纯 touch（仅 updated_at 变化）永不触发——防审计刷屏。
- **allowlist 18→24**：CHECK 重建（DO 块幂等 drop/add），新枚举为既有 18 项严格超集，生产存量行无越界风险。
- **DEF-1（Owner D4=4a，pre-existing defect fix）**：`tags` 补 `updated_at` 列（回填 created_at → NOT NULL → default now()），恢复 0001 既有 `touch_tags_upd`/`audit_tags_upd` 可用性——**恢复既有改名功能，非新增能力**（migration 文件头与 Security Review 均显式标记）。
- **语义不变量（Owner 强制）**：全部 AFTER 审计触发器（只读 NEW/OLD + 写 audit_logs），无 BEFORE 数据守卫、无 NEW/OLD 篡改；SELECT 面（published_assets / search_assets）零改动。

## 3. 证据链（六类，G8 宣布前置）

| # | 证据 | 状态 | 位置 |
| -- | ---- | ---- | ---- |
| 1 | **实际 SQL** | ✅ CONFIRMED | `0007_audit_hardening.sql`（生产已应用，`schema_migrations` 记录；幂等复跑 skip OK） |
| 2 | **隔离库验证 0001→0007** | ✅ CONFIRMED | `evidence/isolated-smoke.md` — 冒烟 20/20 PASS（含 DEF-1 pre/post 对照 C8/C8b、allowlist 24 计数 C12、越界 action 拒绝 C9b） |
| 3 | **公开集合不漂移回归**（Owner 强制项） | ✅ CONFIRMED | `evidence/isolated-smoke.md` §2.2 — Guest 视角快照 A/B **逐字节一致**（NO-DRIFT PASS）；状态迁移语义正确（C2b language_count 随 publish 增减） |
| 4 | **Secret 扫描** | ✅ CONFIRMED | `evidence/secret-scan.md` — git 全历史 237 blob + dist + 工作区，**SECRETS=0/SAMPLES=0**；**阳性对照**（伪造密钥检出 4 类 7 条 → 删除归零）证明检出能力 |
| 5 | **权限/越权回归（M1–M5）** | ✅ CONFIRMED | 隔离库 C10a/b/c（user1 直连 asset_languages 0 行/无审计/RLS 拒绝）+ Phase 7 QA 31/31 + 线上 E2E 13/13（S8 disabled 403）引用 |
| 6 | **生产应用 + 线上抽验** | ✅ CONFIRMED | `evidence/production-apply.md` — 迁移应用 OK；只读 sanity 7/7；**审计写入链路安全构造 7/7**（真实 admin + RLS + 单事务 ROLLBACK 零残留） |

**红线核对**：隔离库全绿（20/20 + NO-DRIFT）后才应用生产；线上写操作全部 ROLLBACK、零残留；`.env` 值全程不回显不落盘；六类证据全部 CONFIRMED 后才宣布 G8。

## 4. Security Review 结论（`02-security-review.md`，G8 唯一硬性验收）

- **五层防线**（Frontend Guard / Route Guard / API Authorization / RLS / Storage）：L1–L4 PASS（复验 + 新增负样本），L5 按 D5/5a 识别为**产品模型残余风险**并记录声明（非阻断）。
- **M6 Secret**：脚本化零命中 + 阳性对照。
- **M7 Audit 完整性**：GAP-A/B 收口后 audit action 全量 24 项清单齐备；防刷屏阴性用例通过。
- **DEF-1 修复记录**：pre-existing defect fix 显式标记，改名功能恢复（隔离库 + 生产结构双侧验证）。
- 未发现阻断性安全缺陷 → **Security Review Passed**。

## 5. 残余风险与非阻断项（记录，不扩大 Scope）

1. **D5/5a**：public bucket 已知公开 URL 可 GET = 当前产品模型下的残余风险（Guest 浏览要求图片公开可读），非 Phase 8 阻断缺陷；5b（private bucket + 签名 URL）/5c（防盗链）为后续独立提案。
2. **wrangler routes 列表权限**（运维）：token 缺 zone Workers Routes 权限，仅影响 route 同步步骤，不影响已绑定自定义域服务（Phase 7 已记录，未扩大 Scope）。
3. **GoTrue 会话撤销 best-effort**：disabled 端点先落库后撤销，失败仅日志；配合 Worker 403 门禁 + RLS 对偶（is_admin 含 disabled=false）闭合。

## 6. Gate G8 宣布

> **Gate G8：PASS — Phase 8 · Security Hardening：CLOSED。**
> 六类证据全部 CONFIRMED（§3）；Security Review Passed（§4）；Owner 强制验收项"补审计不改变 published 双门控语义"以 NO-DRIFT 逐字节快照 + C2b 状态迁移语义证明；DEF-1 按 D4 标记为 pre-existing defect fix 随 0007 修复。
> **Next: Phase 9**（保持 Design Gate → Implementation → Evidence → Gate 节奏）。

## 7. Git 记录

- commit：见 git log（本报告随 Phase 8 全部交付物一并提交推送 main）。
- 涉及文件：`supabase/migrations/0007_audit_hardening.sql`、`scripts/phase8-isolated-smoke.mjs`、`scripts/security-scan.mjs`、`scripts/phase8-prod-spotcheck.mjs`、`docs/phase-8/`（门禁 + Review + 结束报告 + evidence 三件）。
