# Phase 7 · Admin Platform Consolidation — 实施结束报告（Gate G7）

> 状态：**Gate G7 PASS**（六类证据全部 CONFIRMED，含线上 disabled 门禁）
> 日期：2026-09-03 · 依据：`docs/phase-7/01-design-gate.md`（D6 修订版 APPROVED + 附录 A1–A6）
> 执行序：0006 迁移 → Worker → 前端 → 测试（QA 独立验证）→ 部署 → 线上 E2E
> 约束遵守：不扩大 Scope；不重构 Phase 2–6；不新增 Settings 页；Admin Console 仅收敛既有能力；审计 action 固定 allowlist（18 项）；每次管理变更走单事务 SECURITY DEFINER RPC（advisory lock + 锁内重读 + last-admin 普查）；`LAST_ADMIN` 归零保护原子化（Owner 硬门槛）。

---

## 1. 交付物与改动清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| DB | `supabase/migrations/0006_admin_console.sql`（新增，已上生产） | `is_admin()` 扩展为 role='admin' AND profiles.disabled=false；`guard_profile_disabled` 三段式改写；`admin_user_mutation()`（`pg_advisory_xact_lock(hashtext('acmerd_admin_mutation'))` + 锁内重读 actor/target + self 规则 + last-admin 普查 + 枚举审计，仅 service_role）；`admin_stats()` 7 键原子快照；`audit_logs_action_allowlist` CHECK（18 项，DO 块防重）；`(action, created_at desc)` 索引。全幂等、无表结构变更、无数据迁移。 |
| Worker | `worker/index.ts`（唯一改动源文件，+294/-10 之后经 DEF-2 微调） | `authenticate()` 并行取 `profiles.disabled` → 403 `account_disabled`；`authErrBody()` 统一错误体（DEF-2 修复后 500→`internal`）；7 处鉴权 handler 统一；4 新端点（users list / role / disabled / stats）；`callUserMutation()` 经 service-role 调 RPC；错误映射 A4 固化；disabled 端点先落库后 best-effort `POST /auth/v1/admin/users/{id}/logout`。 |
| 前端 | `src/features/admin/api.ts`（新）、`AuthProvider.tsx`（disabled 感知 + role 折叠）、`App.tsx` / `AdminLayout.tsx`（Settings 移除、路由/侧栏收敛）、4 个真实 Admin 页（新）、`AdminPlaceholderPages.tsx`（删）、`downloads/api.ts`（account_disabled 文案）、`types/database.ts`（AuditLogRow） | Admin Console 实装；Dashboard/Storage 各仅一次 `getAdminStats()`；Audit 页 admin JWT 经 RLS 直连；错误码→中文全覆盖。 |
| 文档/脚本 | `docs/phase-7/01-design-gate.md`（含 A1–A6）、`docs/phase-7/evidence/*`（0006-smoke / worker-endpoints / frontend / qa-report / online-e2e）、`scripts/phase7-online-e2e.mjs`（新，可复跑） | 证据链 + 裁决 + 线上 E2E。 |

## 2. Gate G7 六类证据（Owner 硬性要求，逐类 CONFIRMED）

| # | 要求 | 状态 | 证据位置与要点 |
| --- | --- | --- | --- |
| 1 | **实际 SQL** | CONFIRMED | `supabase/migrations/0006_admin_console.sql`（291 行）。隔离库按文件名序 0001→0006 全量应用冒烟 37/37 PASS（含幂等核对 trigger=1/CHECK=1/index=1/mutation=1/stats=1/is_admin=1），随后 `npm run db:migrate` 仅应用 0006 到生产，只读 sanity 通过。→ `evidence/0006-smoke.md` |
| 2 | **权限验证** | CONFIRMED | 隔离库 B1–B7 7/7 PASS（authenticated 无任何直写通道；仅 service_role 可执行 mutation/stats）+ D is_admin 三态（活跃 admin=true / 被禁 admin=false / user=false）。线上复证：S5（user 直连写 user_roles→403）、S6（user 调 Worker→403）。→ `evidence/qa-report.md` §B/§D、`evidence/online-e2e.md` S5–S6 |
| 3 | **并发 last-admin** | CONFIRMED | A5 双 pg.Client 并发交叉互禁：**恰一成功（A→disable B）、败者 `FORBIDDEN`**，并发后活跃 admin≥1 绝无归零；A1 语义裁决（败者被更严的"actor 须活跃"分支先拒）；XB 人工负样本证明 `LAST_ADMIN` raise 可达；XC 普查子查询语义。A4/A6/XB/XC 佐证。→ `evidence/qa-report.md` A5/XB/XC、门禁文档 A1 |
| 4 | **disabled Worker 门禁** | CONFIRMED（静态 + **线上 HTTP**） | QA E 静态全量覆盖 7 处鉴权 handler（downloads image/zip、storage/delete、users/role/disabled/stats），`account_disabled` 在 requireUser/requireAdmin 之前返回。**线上**：部署后 S7（admin 经 Worker 禁用 → 200）+ **S8（被禁用户带有效 JWT 调 `/api/admin/users` → `403 {"error":{"code":"account_disabled"}}`）**。→ `evidence/qa-report.md` §E、`evidence/online-e2e.md` S7–S8 |
| 5 | **RLS 回归** | CONFIRMED | A8/A9（被禁 admin 直连全拒：draft 不可见、INSERT→RLS 拒、UPDATE=0 行；自助解禁→`CHANGING_DISABLED_REQUIRES_ADMIN`）、B4–B7（闭包：活跃 admin 也无法直改他人 disabled=0 行；自禁→`SELF_DISABLE_FORBIDDEN`）、C 系列（published 双层可见性）。线上复证 S5。→ `evidence/qa-report.md` A8–A9/B4–B7 |
| 6 | **Phase 2–6 回归** | CONFIRMED | C1–C6 代表用例（Phase2 可见性/权限、Phase3 审计、Phase4 storage、Phase5 download_source 域名守卫、Phase6 search_assets/tags），各 Phase 至少一条并标注迁移文件；**对照库（0001–0005，不含 0006）基线**证明"无 0006 行为变化"。→ `evidence/qa-report.md` §C |

> 六类证据汇总文件：`evidence/qa-report.md`（DB 套件 31/31 PASS + 静态审查）+ `evidence/online-e2e.md`（线上 13/13 PASS）。

## 3. 部署与线上验证记录

- 迁移：`npm run db:migrate` 应用 0006（2026-09-03，批次 A，全幂等，schema_migrations 记录）。
- Worker + 前端：`npm run deploy`（vite build 1679 modules → wrangler deploy）。**Worker 脚本与 3 个静态资源上传成功、自定义域立即生效**（判别器：`/api/admin/stats` 无 token → 401 JSON，非旧版 SPA 回落）。
- ⚠️ 运维注记：部署命令末尾 wrangler 同步 `workers/routes` 时报 `Authentication error [code:10000]`——token 缺该 zone 的 Workers Routes 读权限，**仅影响 route reconcile 步骤**；`routes=[{custom_domain=true}]` 为服务端既有绑定，新版本照常经 `image.acmerd.com` 提供服务（线上 13/13 证明）。如需消除告警：给 CLOUDFLARE_API_TOKEN 增加 `Zone → Workers Routes → Read/Edit` 权限，或后续阶段改用 dashboard 管理路由。
- 线上 E2E：13 PASS / 0 FAIL；临时用户（`phase7.e2e.<rand>@<admin-domain>`）已删除，`profiles`/`user_roles` 级联 0 残留（`evidence/online-e2e.md`）。

## 4. 裁决记录（门禁附录 A1–A6，对实现与 QA 有约束力）

- **A1**：并发交叉互禁败者 = `FORBIDDEN`（非 `LAST_ADMIN`）——维持现语义（更严格），归零由结构保证。
- **A2**：审计 allowlist 实为 18 项（非门禁草案 19 项）；生产存量 12 项全部 ⊆ allowlist。
- **A3**：0006 隔离库冒烟全绿后上生产，只读 sanity 通过。
- **A4**：users 端点自包含 envelope（分页 total 需达浏览器端）；role 缺省 'user' 仅展示层；撤销通道 = `/auth/v1/admin/users/{id}/logout`；错误映射固化（403/409/404/400/502）。
- **A5**：Dashboard/Storage 各仅一次 stats；AuthProvider 折叠 role='user'；Profile 不加徽标；用户端仅 downloads 增补 403 文案；**profiles 他人 disabled 唯一可写通道 = service_role RPC（RLS 闭包成立）**。
- **A6**：**DEF-1**（0001 tags 无 updated_at 但 `touch_tags_upd` 引用——pre-existing·中）不修复、不阻塞 G7，排期 Backlog；**DEF-2**（authErrBody 500 回退 'unauthorized'——cosmetic）发布前已修（按状态推导 fallback，401→'unauthorized' / 500→'internal' / 403 account_disabled 保留），typecheck=0。

## 5. 缺陷与遗留（Follow-up / Backlog）

1. **[Backlog] DEF-1 — `tags` 表缺 `updated_at`（pre-existing）**：`0001_initial_schema.sql` L131-136 `tags` 无该列，L165 `touch_tags_upd` 引用导致任何 `UPDATE public.tags` 报 `record "new" has no field "updated_at"`。影响：`AdminTagsPage` 改名功能当前不可用；`tag.updated` 审计运行时不可达。建议排期：新 migration 补 `updated_at timestamptz not null default now()`（与 profiles/assets/images 同型，无数据迁移）或按 D4 语义删触发器。三路径证实见 `evidence/qa-report.md` §3。
2. **[运维] wrangler route 同步权限**：见 §3 注记，建议补 token 的 Zone Workers Routes 权限。
3. **[无害] `requireAdmin` 对非 admin 用户的 403 错误体 code='unauthorized'**（message='Admin required'）：既有语义（A4 未覆盖此细项），前端正常用户不达 admin 页；如需更精确可后续将 message 型 403 的 code 与状态对齐。

## 6. Gate G7 宣布

Phase 7（Admin Platform Consolidation）——0006 原子化迁移 + Worker D2 disabled 硬门禁 + 4 个 admin 端点 + 前端 Admin Console 四页实装——经：

1. 隔离库 DB 套件 **31/31 PASS** + 冒烟 37/37；
2. 独立 QA 静态审查（权限矩阵/RLS/Worker/前端/构建）全绿；
3. 生产迁移后只读 sanity 通过；
4. 部署后线上 E2E **13/13 PASS**（含 **S8 disabled 门禁 → 403 account_disabled** 线上证据）；
5. 六类 Owner 要求证据全部 CONFIRMED（§2）。

**特此宣布：Gate G7 PASS。** Phase 7 满足门禁 D1–D6（D6 修订版）全部要求，未扩大 Scope，未重构 Phase 2–6，未引入阻断性缺陷。Phase 7 CLOSED。
