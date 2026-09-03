# Phase 8 · 生产应用 0007 + 线上安全构造抽查 — 证据

> 批次：生产 migration + 线上抽验（Implementation 第 5 步） · 执行：主理人（Agent） · 日期：2026-09-03
> 依据：`docs/phase-8/01-design-gate.md` §10 证据 #1/#6（红线：隔离库全绿后才碰生产；线上仅读/安全构造）
> 状态：**0007 已应用生产 · 只读 sanity 7/7 · 审计写入链路安全构造 7/7 · 幂等复跑 OK · 零生产残留**

---

## 1. 前置条件（红线核对）

- 隔离库 0001→0007 冒烟 20/20 PASS + NO-DRIFT（`evidence/isolated-smoke.md`）后方执行本步骤。
- 生产预检（只读）：`schema_migrations` 含 0001–0006（无 0007）；audit_logs CHECK 为 18 项；`asset_languages` 仅有 `touch_asset_languages_upd`（GAP-A 生产侧复证）。
- 全程 `.env` 值不回显不落盘；线上写操作全部在单事务内执行并最终 ROLLBACK。

## 2. 迁移应用

```text
apply 0007_audit_hardening.sql ... OK
migration complete
```

- 应用后幂等复跑：`skip 0007_audit_hardening.sql (already applied)` → OK。
- 生产 `schema_migrations` 现含 `0007_audit_hardening.sql`（S1 PASS）。

## 3. 只读结构 sanity（S1–S7，7/7 PASS）

| # | 检查 | 结果 |
| -- | ---- | ---- |
| S1 | schema_migrations 记录 0007 | PASS |
| S2 | audit allowlist 总项数 = 24 | PASS（count=24） |
| S3 | 含 5×asset_language.*（created/published/unpublished/updated/deleted） | PASS |
| S4 | 含 image.updated | PASS |
| S5 | asset_languages 4 个审计触发器（ins/del/status/upd） | PASS |
| S6 | images audit_images_upd 触发器 | PASS |
| S7 | tags.updated_at NOT NULL default now()（DEF-1 修复落生产） | PASS |

## 4. 线上审计写入链路抽查（安全构造，T1–T7 共 7/7 PASS）

方法：选取**生产真实已发布资产**的一条已发布语言行及其下图片，以**真实活跃 admin 身份**（user_roles join profiles，RLS 真实生效）在**单事务内**执行状态翻转与业务列变更 → 断言审计行产生 → **最终 ROLLBACK**（任何结果都回滚，数据与审计零残留）。

| # | 场景 | 结果 |
| -- | ---- | ---- |
| T1 | 语言 published→draft → `asset_language.unpublished` 审计 1 行 | PASS |
| T2 | 语言 draft→published → `asset_language.published` 审计 1 行 | PASS |
| T3 | images `sort_order+1` 业务列变化 → `image.updated` 审计 1 行 | PASS |
| T4 | 阴性：语言 no-op UPDATE（仅 touch updated_at）→ 无 `asset_language.updated` | PASS（防刷屏） |
| T5 | 阴性：images no-op（`sort_order=sort_order`）→ 无额外 `image.updated` | PASS |
| T6 | ROLLBACK 后语言状态还原 published | PASS |
| T7 | ROLLBACK 后审计行零残留（count=0） | PASS |

> 目标行（仅证据引用，已脱敏语义）：lang_id / asset_id / img_id 均为真实 UUID；admin 为生产活跃管理员。操作未提交，生产业务数据与 audit_logs 均无变化。

## 5. 结论

- 证据 #1（实际 SQL，生产已应用）与证据 #6（生产应用 + 线上抽验）**CONFIRMED**。
- 0007 在生产环境的触发器安装、allowlist 24 项、DEF-1 补列均验证通过；审计写入链路（含阴性防刷屏与回滚零残留）线上闭环。
- 可复跑：`node scripts/phase8-prod-spotcheck.mjs`（结构 sanity + 安全构造，自带 ROLLBACK 红线）。
