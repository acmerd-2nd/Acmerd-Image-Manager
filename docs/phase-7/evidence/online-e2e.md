# Phase 7 · 线上 E2E 证据（任务 #5 部署后执行，2026-09-03）

> 执行：team-lead（部署收口环节）· 依据：`docs/phase-7/01-design-gate.md`（A1–A6）+ QA 报告就绪度表中唯一 PENDING_DEPLOY 项
> 目的：补齐「disabled Worker 门禁」的**线上 HTTP** 证据（QA 已在隔离库 + 静态层证明其余五类，本文件负责线上闭环）
> 红线：全程不回显 secret/token/密码；临时用户为一次性 `phase7.e2e.<rand>@<管理员域名>`（email_confirm=true），末尾删除并验证 `profiles`/`user_roles` 级联 0 残留；未触碰任何既有真实行；脚本可复跑：`scripts/phase7-online-e2e.mjs`

## 0. 环境

- Worker：`https://image.acmerd.com`（自定义域，新构建已上线——判别器 `/api/admin/stats` 无 token 返回 `401 {"error":{"code":"unauthorized","message":"Missing bearer token"}}`，非旧版 SPA 回落）
- Supabase：`ctddbmadywtdufazhwiq.supabase.co`（PG 17.6）
- 真实管理员：`.env` `ADMIN_EMAIL/ADMIN_PASSWORD`（本地记录账号，密码登录取 JWT）

## 1. 结果：13 PASS / 0 FAIL

| # | 断言 | 结果 | 证据意义 |
| --- | --- | --- | --- |
| S0 | `GET /api/health` → 200 | PASS | 新 Worker 上线存活 |
| S1 | 真实管理员密码登录 → 200 | PASS | 取管理员 JWT 作为高权限 actor |
| S2 | admin 调 `GET /api/admin/users` → 200 自包含 envelope | PASS | D1 列表端点线上可用（含 total/page/per_page） |
| S2.1 | 管理员本人在列表中 role=admin 且 disabled=false | PASS | D2 双表 join 口径线上正确 |
| S3 | admin 调 `GET /api/admin/stats` → 200 数值快照 | PASS | D5 单一聚合端点线上可用 |
| S4 | **admin JWT 经 RLS 直连** `audit_logs` → 200 rows | PASS | D4「审计读直连、无 Worker 读端点」线上成立 |
| S5 | 普通用户 G 直连写 `user_roles` → 403 | PASS | 权限矩阵 B1 的线上负样本（GRANT 仅 service_role） |
| S6 | 普通用户 G 调 Worker `/api/admin/users` → 403 | PASS | requireAdmin 门禁线上生效 |
| S7 | **admin 经 Worker 禁用 G** → 200 `{disabled:true, disabled_changed:true}` | PASS | Worker→service-role RPC→原子落库→审计→best-effort 撤会话全链线上走通 |
| **S8** | **★ 被禁用户 G 的 JWT 调 Worker `/api` → `403 {"error":{"code":"account_disabled"}}`** | PASS | **D2 disabled 硬门禁线上 HTTP 证据（QA PENDING_DEPLOY 项闭环）**；GoTrue best-effort logout 未使旧 access token 失效（GoTrue 对未过期 access token 的 `/auth/v1/user` 校验为无状态签名/过期校验），故 Worker 命中 profiles.disabled=true 分支 |
| S9 | admin 经 Worker 重新启用 G → 200 `{disabled:false}` | PASS | 启用反向路径 sanity（RPC 幂等审计） |
| cleanup | 临时用户删除 + `profiles`/`user_roles` 级联 0/0 残留 | PASS | `profiles.id`/`user_roles.user_id` 均 `references auth.users(id) on delete cascade`（0001），无孤儿行 |

## 2. 对 Gate G7 就绪度的贡献

QA 报告就绪度表 #4「disabled Worker 门禁」由 `静态 CONFIRMED · 线上 HTTP PENDING_DEPLOY` 更新为 **CONFIRMED（静态 + 线上 HTTP 双证据）**：S8 直接证明被禁账号携带有效 JWT 访问 `/api/admin/*` 返回 `403 account_disabled`，在 requireUser/requireAdmin 之前被拒（E 静态审查结论的运行时印证）。

## 3. 一次性临时行记录（已全部清理）

- 创建：`phase7.e2e.<rand>@<管理员域名>` × 1（user-G，禁用→启用→删除）；若 S8 主通道 401 则另建 user-G2 走直连 RPC 通道（本次未触发，主通道直接命中 403）。
- 删除：`DELETE /auth/v1/admin/users/{id}`（service role）→ 级联清 `profiles`/`user_roles`；终态扫描 0 残留。
- 审计残留：S7/S9 各落 1 条 `user.disabled`/`user.enabled`（actor=真实管理员、target=临时用户 uuid）。临时用户删除后 `actor_id` 因 FK `on delete set null`（0001）置空；target 仅存于 metadata JSON——属可接受的受控测试痕迹，不影响任何既有用户。
