# Phase 8 · Migration 0007 隔离库冒烟 + 公开集合不漂移回归 — 证据

> 批次：隔离库验证（Implementation 第 2 步） · 执行：主理人（Agent） · 日期：2026-09-03
> 依据：`docs/phase-8/01-design-gate.md`（Owner 裁决版）§6.4 / §10#2 / §10#3
> 状态：**0001→0007 全量应用 OK · 冒烟 20/20 PASS · 一次性库已自动 DROP 清理**
> 红线核对：全程未触碰生产 public 数据；未 git add/commit；`.env` 值未回显未落盘。

---

## 0. 可复跑

```bash
node scripts/phase8-isolated-smoke.mjs   # 一次性库 acmerd_phase8_gate_<rand>，finally 强制 DROP
```

（依赖：`node_modules/pg`、`.env` DATABASE_URL 直连库、postgres 角色 `rolcreatedb=true`。）

## 1. 方法（镜像 Phase 7 隔离验证，含 Supabase 桩）

1. `CREATE DATABASE acmerd_phase8_gate_<rand>`（全新库）。
2. 建 Supabase 桩：`auth` schema + `auth.uid()`（读 `request.jwt.claim.sub` GUC）+ `auth.users`（空壳，含 handle_new_user 所需列）+ `storage.buckets/objects`（0001 策略与 bucket 插入依赖）+ `schema_migrations`（0002 REVOKE 引用）+ RLS 使能 + `alter default privileges`（镜像 Supabase 对 anon/authenticated/service_role 的自动授权）。
3. 按文件名序应用 `0001_initial_schema.sql → 0002_grants.sql → 0003_asset_integrity.sql → 0004_download_source_url_guard.sql → 0005_search_and_tags.sql → 0006_admin_console.sql`（全部 apply OK）。
4. 播种固定资产图谱（root 身份；受 0003 `guard_asset_publish` 约束：资产先 draft 插入，语言/图片就绪后再提升 published）：
   - asset P：published；语言 en（published，2 图）、de（draft，1 图）；标签 1 个挂接。
   - asset D：draft（不可见于公开集合）。
5. **快照 A**（Guest 视角 = `authenticated` 且无 `request.jwt.claim.sub`，`auth.uid()=null`；与 anon 等价——相关表 SELECT 策略均无 TO 子句）：
   `published_assets` 全行、双层可见资产-语言计数、可见图片计数、published 资产挂标签计数。
6. 应用 `0007_audit_hardening.sql` → **快照 B** 同组查询 → 逐字节对比。
7. 触发器语义用例（admin1 活跃 admin 身份，RLS 真实生效）逐项断言审计行。

> 注：本集群 postgres **非超级用户**且仅成员于 `authenticated`（Phase 7 S0 已证），故 Guest 视角采用 authenticated-无-JWT 而非 `SET ROLE anon`；两类角色在上述表的 SELECT 策略上语义一致。

## 2. 冒烟结果（20/20 PASS）

### 2.1 DEF-1 前后对照（pre-existing defect fix 实证）

| # | 场景 | 结果 |
| -- | ---- | ---- |
| DEF-1 pre | 0007 前，admin 改名 tags | **PASS**：`record "new" has no field "updated_at"`（既有 touch_tags_upd 阻断，复现 QA DEF-1） |
| C8 | 0007 后，admin 改名 tags | **PASS**：改名成功 + `updated_at` 已落值 |
| C8b | 改名审计 | **PASS**：`tag.updated` 审计行恢复产生（audit_tags_upd 现可用） |

### 2.2 Owner 强制项：公开数据集合不漂移（§6.4）

| # | 场景 | 结果 |
| -- | ---- | ---- |
| NO-DRIFT | 快照 A vs 快照 B（0007 前后，4 组 Guest 视角查询） | **PASS**：逐字节一致（结构上 0007 仅追加 AFTER 审计触发器 + tags 补列 + 换 CHECK，SELECT 面零改动） |

### 2.3 asset_languages 审计语义（GAP-A，Owner D2=2a）

| # | 场景 | 结果 |
| -- | ---- | ---- |
| C1 | INSERT → `asset_language.created` | PASS：1 行 |
| C2 | draft→published → `asset_language.published` | PASS：1 行（与普通 updated 分离） |
| C2b | es published 后 Guest 可见集合 | PASS：`language_count=2`（语义正确，随状态迁移增减） |
| C3 | published→draft → `asset_language.unpublished` | PASS：1 行 |
| C4 | 业务列变化（language_code es→it）→ `asset_language.updated` | PASS：1 行 |
| C4b | no-op/纯 touch UPDATE | PASS：不新增 updated 审计（防刷屏） |
| C5 | DELETE → `asset_language.deleted` | PASS：1 行 |
| C11 | 五种语义均可独立产生 | PASS：created/deleted/published/unpublished/updated 齐备 |

### 2.4 images UPDATE 审计（GAP-B，Owner D3=3a）

| # | 场景 | 结果 |
| -- | ---- | ---- |
| C6 | `sort_order` 1→9 → `image.updated` | PASS：1 行（WHEN 命中） |
| C7 | no-op（`sort_order=sort_order`，touch 只刷 updated_at） | PASS：不触发（WHEN 排除纯 touch） |

### 2.5 allowlist / RLS 负样本 / 目录

| # | 场景 | 结果 |
| -- | ---- | ---- |
| C9 | `image.updated`（24 项内）可插 | PASS |
| C9b | 越界 action（`hacker.pwned`）被 CHECK 拒绝 | PASS：`violates check constraint "audit_logs_action_allowlist"` |
| C10a | user1 UPDATE asset_languages | PASS：RLS `using(is_admin())` 过滤 → 0 行（无旁路） |
| C10b | user1 尝试不产生审计行 | PASS：before=1 after=1 |
| C10c | user1 INSERT asset_languages | PASS：`new row violates row-level security policy` |
| C12 | allowlist CHECK 枚举恰 24 项 | PASS：count=24 |

## 3. 结论

- 0007 全部幂等（重复应用第 2 次 OK，无报错）。
- **补审计未改变 published 双门控语义**：静态上 0007 只追加 AFTER 审计触发器（写 audit_logs）+ tags 补列 + 换 CHECK；动态上快照 A/B 逐字节一致 + C2b 状态迁移语义正确。
- DEF-1 修复闭环（改名恢复 + updated_at 落值 + tag.updated 审计）。
- 无阻断缺陷 → 可进入 Secret Scan / Security Review / 生产应用。
