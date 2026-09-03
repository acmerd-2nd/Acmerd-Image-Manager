# Phase 7 · Admin Platform Consolidation — Design Gate（D6 修订版）

> 状态：**APPROVED with required security adjustment（D6 修订）** — Owner 已确认采纳评审裁决  
> 日期：2026-09-03 · 评审来源：独立审阅（ChatGPT）D1–D5 通过、D6 要求修订  
> 依据：`【总纲】` #39–45 / `【分阶段】` Phase 7 / `docs/phase-0/08-api-contract.md`、`11-admin-workflow.md`  
> 本文件 = Phase 7 开工前报告（开始报告 / Design Gate）。Owner 确认后进入实施，实施期严禁跳阶段、严禁顺手重构。

---

## 0. 一句话定位（Phase 7 不是"新建一套 Admin"）

Phase 3–6 已零散落地：Admin Assets（CRUD/上传/排序/Cover/Publish）、语言管理、Tags 管理、Download Sources。  
**Phase 7 = Admin Platform Consolidation**：把已有后台能力 + 尚缺的 Dashboard / Users / Storage / Audit Logs  
统一收敛成一个导航一致的 Admin Console；**不重写 Assets / Tags / Search / Download 任何既有逻辑**（评审附加约束）。

---

## 1. 评审裁决记录（binding）

| 编号 | 裁决                  | 最终结论                                                                                                                                      |
| -- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | 用户列表服务端化            | **APPROVED**：用户列表经 Worker + Supabase Auth Admin API + service-role join（user_roles + profiles）产出；**不放宽 user_roles 的 RLS**（客户端仍只见本人行、无写权）。 |
| D2 | 禁用状态硬门禁             | **APPROVED**：Worker 的 `authenticate()` 对**每一个** `/api` 请求强制校验 `profiles.disabled`；这是硬安全门，session 撤销仅 best-effort。                         |
| D3 | GoTrue Admin API 契约 | **APPROVED**：实施前必须用**本 Supabase 实例**核实 Auth Admin API 实际契约（用户列举/会话撤销端点是否存在及返回结构）；**撤销失败绝不阻塞 `profiles.disabled=true`**。                   |
| D4 | 审计读取通道              | **APPROVED**：Audit Logs 维持 admin-JWT 经既有 RLS 直连读取；**不新增** Worker 审计读端点。                                                                   |
| D5 | 存储用量口径              | **APPROVED**：基于 `SUM(images.file_size)` 的 DB 记账，UI **明确标注"按数据库记录估算"**（非 Storage 实查）。                                                      |
| D6 | 用户变更安全规则            | **MODIFY（本版修订核心）**：见 §2。                                                                                                                  |

评审附加约束（全部采纳，见 §9 核对表）：

1. self-disable = 禁止；self-demote = V1 禁止。
2. admin 角色变更 / admin 禁用/启用必须带**原子化 last-admin 保护**；禁止"非原子 COUNT → UPDATE"。
3. 每次变更前，服务端**重新读取目标用户实际 role/status**。
4. Dashboard 统计走**单一 stats 端点**聚合，禁止前端多个小请求拼装。
5. 审计 action 取值来自**固定服务端 allowlist**。
6. 保留 Phase 2–6 全部不变量；不重构 Assets / Tags admin 逻辑；**不加 Settings 功能**。
7. 开工前已推送纯文档提交 `5a193cb` 至 main（2026-09-03，`edf1bf0..5a193cb` ✅）。

---

## 2. D6 修订细则（本次门禁的关键变更）

- **self-disable：禁止**（任何角色都不可将自己 `disabled=true`）。
- **self-demote：V1 禁止**（admin 不可将自己降为 user）。
- **admin 降级 / admin 禁用 / admin 启用** 全部必须满足"变更后仍 ≥1 名**活跃 admin**"，且判定在**同一原子单元**内完成。
- "活跃 admin" 定义为：`user_roles.role='admin' AND profiles.disabled=false`。
- 语义：禁用 admin ≠ 降级——保留其 `admin` 角色但使其立即失去全部管理能力（RLS 层同步失效，见 §4.4）。

---

## 3. 范围与边界

### Scope（本 Phase 交付）

1. **DB Migration `0006`**：原子用户变更函数 + 审计 allowlist + 配套触发器收紧 + `is_admin()` 语义（§4、§7）。
2. **Worker**：
   - `authenticate()` 全量校验 `profiles.disabled`（D2 硬门禁）。
   - `GET /api/admin/users`（Auth Admin API 列举 + service-role join，D1）。
   - `POST /api/admin/users/:userId/role`、`POST /api/admin/users/:userId/disabled`（D6 原子路径）。
   - `GET /api/admin/stats`（单一统计端点；Dashboard + Storage 共用，D5 + 附加约束 4）。
3. **前端**：
   - Dashboard / Users / Storage / Audit Logs 四页从占位变实装。
   - Admin 侧栏收敛为：Dashboard / Assets / Users / Tags / Storage / Audit Logs（**移除 Settings**）。
   - `AuthProvider` 感知 disabled（被禁 admin 不再进入后台路由，仅影响"身份展示"层，不改 Assets/Tags 逻辑）。
4. **测试**：migration 冒烟（含并发/交叉互禁用例）、Worker 安全用例、线上 UI E2E、Phase 2–6 不变量回归。

### Out of Scope（明确不做）

- 重写/重构 Assets、Tags、Search、Download、语言管理的任何既有逻辑与 RLS。
- Settings 页面/功能（含路由与侧栏项，全部移除）。
- 放宽 `user_roles` 的任何 RLS/GRANT。
- 下载次数统计、Storage 文件浏览器、用户头像上传、密码重置 UI。
- GoTrue 登录侧钩子阻断禁用用户登录（Supabase 无此挂点）；禁用语义以 Worker 门禁 + RLS 为边界。

---

## 4. 关键安全设计：**原子化最后管理员保护**（D6 硬门槛的确切方案）

### 4.1 为什么"非原子 COUNT → UPDATE"不行

两个并发请求的经典漏洞（**必须防住的场景**）：

```
初始：恰好 2 名活跃 admin（A、B）
T1: A 请求 禁用 B      T2: B 请求 禁用 A
    1) SELECT count(admin) → 2       1) SELECT count(admin) → 2
    2) UPDATE B disabled=true        2) UPDATE A disabled=true
→ 双双提交：活跃 admin = 0 ⇒ 系统被锁死，无人在线可解禁。
```

另外，仅对"目标行 FOR UPDATE"也不充分（上例两者各锁对方行、快照互不可见）。  
任何"先数后改"且两个语句之间没有**事务级互斥**的方案，都属于被禁止的"非原子 COUNT → UPDATE"。

### 4.2 机制选型：**单一 SECURITY DEFINER 函数 + 事务级 advisory lock**

| 项      | 方案                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一写入通道 | Worker 以 service role 调 RPC `public.admin_user_mutation(...)`。该函数是**唯一**被允许改 `user_roles.role` / `profiles.disabled` 的代码路径（配合 §4.4 触发器收紧，客户端/直连 SQL 均无法绕过）。      |
| 原子性    | 函数体 = PostgREST RPC 的**单一隐式事务**：校验 + 更新 + 审计同生共死。                                                                                                                |
| 并发互斥   | 函数第一行 `perform pg_advisory_xact_lock(hashtext('acmerd_admin_mutation'))`。**常量键**事务级咨询锁把所有"管理员普查类变更"串行化：锁在提交/回滚时自动释放，天然无死锁（所有变更按同一把锁排队），无需多行 FOR UPDATE 的排序与快照推理。 |
| 变更前重读  | 在锁内**重新读取** actor 与 target 的 `user_roles.role` + `profiles.disabled`（忽略调用方传入的任何"当前状态"），以最新值裁决。                                                                   |

> 为什么不用裸行锁：交叉互禁场景需要锁住"活跃 admin 全集"，要处理加锁顺序/死锁/READ COMMITTED 快照三个问题，可读性差且易错。  
> advisory lock 语义一句话：**全系统同一时刻只允许一个管理员普查变更在途**——这些操作是低频管理动作，串行化代价可忽略，换来的是简单、可证明、无死锁。

### 4.3 函数契约与规则（指示性 SQL，实施时定稿）

```sql
create or replace function public.admin_user_mutation(
  p_actor    uuid,            -- 操作者（Worker 从 JWT 解析后传入）
  p_target   uuid,            -- 目标用户
  p_role     app_role default null,   -- null = 不改角色
  p_disabled boolean default null     -- null = 不改禁用态
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role  text;
  v_actor_dis   boolean;
  v_tgt_role    text;
  v_tgt_dis     boolean;
  v_action      text;
begin
  perform pg_advisory_xact_lock(hashtext('acmerd_admin_mutation'));  -- ← 原子门槛

  -- (1) 锁内重读 actor：必须是"活跃 admin"（role=admin 且未禁用），否则拒绝
  select ur.role, coalesce(p.disabled,false)
    into v_actor_role, v_actor_dis
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
   where ur.user_id = p_actor;
  if v_actor_role <> 'admin' or v_actor_dis then
    raise exception 'FORBIDDEN: actor is not an active admin';
  end if;

  -- (2) 锁内重读 target 实际状态（约束 3：绝不信任调用方传入的现状）
  select ur.role, coalesce(p.disabled,false)
    into v_tgt_role, v_tgt_dis
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
   where ur.user_id = p_target;
  if not found then raise exception 'TARGET_NOT_FOUND'; end if;

  -- (3) self 规则
  if p_target = p_actor and (p_role = 'user' or p_disabled = true) then
    raise exception 'SELF_OPERATION_FORBIDDEN: self-demote / self-disable is not allowed';
  end if;

  -- (4) 计算目标"变更后是否仍是 admin 角色 + 是否活跃"，做 last-admin 裁决
  --     仅在目标将失去"活跃 admin"身份时触发普查（锁内计数 → 天然原子）
  if (v_tgt_role = 'admin' and v_tgt_dis = false)      -- 目标当前是活跃 admin
     and ( (p_role = 'user') or (p_disabled = true) )  -- 且本操作将使其失去该身份
     and not exists (
       select 1
       from public.user_roles ur2
       join public.profiles p2 on p2.id = ur2.user_id
       where ur2.user_id <> p_target
         and ur2.role = 'admin'
         and p2.disabled = false
     ) then
    raise exception 'LAST_ADMIN: operation would leave no active admin';
  end if;

  -- (5) 落变更（null 字段 = 不变；同值 = no-op 跳过审计）
  ...
  -- (6) 审计（action 取自函数内固定枚举，见 §5 allowlist）
  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (p_actor, v_action, 'profiles', p_target::text,
          jsonb_build_object('role_from', v_tgt_role, 'role_to', p_role,
                             'disabled_from', v_tgt_dis, 'disabled_to', p_disabled));
  return jsonb_build_object('role', ..., 'disabled', ...);
end; $$;

revoke all on function public.admin_user_mutation(uuid, uuid, app_role, boolean) from public;
grant  execute on function public.admin_user_mutation(uuid, uuid, app_role, boolean) to service_role;
```

裁决矩阵（函数内不可变）：

| 操作             | target=actor？ | 条件成立才放行                      | 冲突错误                     |
| -------------- | ------------- | ---------------------------- | ------------------------ |
| 降级 admin→user  | 是             | 永不                           | `SELF_DEMOTE_FORBIDDEN`  |
| 禁用（含 admin）    | 是             | 永不                           | `SELF_DISABLE_FORBIDDEN` |
| 降级 admin→user  | 否             | 锁内普查：除 target 外仍 ≥1 活跃 admin | `LAST_ADMIN`             |
| 禁用 admin       | 否             | 同上                           | `LAST_ADMIN`             |
| 禁用普通 user      | 否             | 恒放行（不影响 admin 普查）            | —                        |
| 启用（user/admin） | —             | actor 是活跃 admin 即可           | —                        |
| 提升 user→admin  | 否             | 恒放行（增加 admin，无孤儿风险）；审计仍记     | —                        |

### 4.4 RLS / 触发器配套收紧（让"禁用"成为真正的安全门）

只做**收紧**，不改动任何 `user_roles` 策略（D1 约束）：

1. **`is_admin()` 语义扩展**：`role='admin' AND profiles.disabled=false`。  
   效果（一处修改、全表生效）：被禁 admin 的 assets/tags/download_sources/audit_logs/profiles 管理读、  
   直连 CRUD、Storage 上传/删除、`write_audit` 全部立即失效 —— **禁用 = 完整失去管理能力**（而不只是被 Worker 挡在墙外）。
   > 这是 D2 在 RLS 层的对偶实现：Worker 门禁防 `/api`，`is_admin()` 收紧防"带 JWT 直连 Supabase"。二者缺一，禁用语义都不完整。
2. **`guard_profile_disabled` 触发器改写**（三段式）：
   ```sql
   if new.disabled is distinct from old.disabled then
     if auth.uid() = new.id and new.disabled then
       raise exception 'SELF_DISABLE_FORBIDDEN';                       -- 自禁永禁（含 admin）
     end if;
     if not ( current_user in ('postgres','service_role')              -- 受控通道
              or public.is_admin() ) then
       raise exception 'CHANGING_DISABLED_REQUIRES_ADMIN';             -- 其余一律拒绝
     end if;
   end if;
   ```
   解释：客户端（authenticated）经 RLS 只能改自己行，自禁被第一支拒绝；被禁者自助解禁因 `is_admin()` 已含  
   `disabled=false` 而被第二支拒绝（**禁止自愈**）；服务端通道（Worker 经函数 / migration）走 `postgres|service_role` 豁免分支放行。
3. **audit action 固定 allowlist 落地**：`audit_logs.action` 增加 `CHECK (action in (...))`，全集见 §5；  
   与现有 0001/0003/0005 触发器字面量逐一核对无遗漏（已核对），保证"任何审计写入都不可能绕过枚举"。

### 4.5 验证用例（迁移冒烟必过，实施期逐条执行）

| #  | 场景                                                               | 期望                                          |
| -- | ---------------------------------------------------------------- | ------------------------------------------- |
| 1  | 唯一 admin 自降级                                                     | 拒绝 `SELF_DEMOTE_FORBIDDEN`                  |
| 2  | 唯一 admin 自禁用                                                     | 拒绝 `SELF_DISABLE_FORBIDDEN`                 |
| 3  | 唯一 admin 被另一 user 降级                                             | 拒绝（actor 非活跃 admin → `FORBIDDEN`）           |
| 4  | 2 活跃 admin：A 禁 B                                                 | 放行；活跃 admin 剩 A                             |
| 5  | 2 活跃 admin：A 禁 B **并发** B 禁 A                                    | 恰一个成功、另一个被拒（advisory lock 串行化后验证；败者实际为 `FORBIDDEN`——语义更强，见附录 A1） |
| 6  | 2 活跃 admin：A 禁 B 后，A 再自禁                                         | 拒绝（规则 2）                                    |
| 7  | A 禁普通 user                                                       | 放行 + audit `user.disabled`                  |
| 8  | 被禁 admin 直连 Supabase 改 assets / 上传                               | RLS/Storage 拒绝（`is_admin()`=false）          |
| 9  | 被禁 admin 自助解禁                                                    | 拒绝（触发器第二支）                                  |
| 10 | 启用：B 启用 A（A 已禁）                                                  | 放行 + audit `user.enabled`；A 恢复全部能力          |
| 11 | 审计 action 白名单外字符串直插                                              | CHECK 拒绝                                    |
| 12 | 每次变更审计齐全（role_changed/disabled/enabled，metadata 含 from/to/actor） | 通过                                          |

---

## 5. 审计 action 固定 allowlist（服务端）

新增 `audit_logs.action CHECK` 全集（共 **18 项** = 既有 15 + Phase 7 新增 3；文案初版"19 / 既有 16"系笔误，以本清单为准，见附录 A2）：

```plaintext
asset.created  asset.updated  asset.deleted  asset.published  asset.unpublished
asset.archived asset.restored
image.uploaded image.deleted
tag.created  tag.updated  tag.deleted
asset.tag_added  asset.tag_removed
download_source.updated
user.role_changed  user.disabled  user.enabled        ← Phase 7 新增
```

Worker 端点**不接受客户端传来的任何 action 字符串**：语义由端点固定（`role` → `user.role_changed`；  
`disabled=true` → `user.disabled`；`disabled=false` → `user.enabled`），实际写入在 DB 函数内完成。

---

## 6. Worker API 新增（对齐 docs/phase-0/08-api-contract.md）

| 端点                                       | 鉴权                 | 行为                                                                                                                                                                                              |
| ---------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/users`                   | requireAdmin + 未禁用 | service role 列举 Auth Admin API 用户 → join `user_roles`(role) + `profiles`(disabled/display_name) → 返回 `[{id,email,created_at,last_sign_in_at,role,disabled,display_name}]`。分页游标按实例实际契约实施（D3 核实）。 |
| `POST /api/admin/users/:userId/role`     | 同上                 | body `{role:"user"\|"admin"}`；调 `admin_user_mutation`；错误映射 `403/404/409/400`。                                                                                                                   |
| `POST /api/admin/users/:userId/disabled` | 同上                 | body `{disabled:boolean}`；调 `admin_user_mutation`；**先落库后**按 D3 契约 best-effort 尝试会话撤销，失败仅记日志、不回滚、不阻塞。                                                                                            |
| `GET /api/admin/stats`                   | 同上                 | 单一聚合端点（D5 + 约束 4）：`totalAssets / assetsByStatus / totalImages / totalUsers / disabledUsers / storageUsedBytes / imagesByLanguage`。内部 = 一次 `admin_stats()` service-role RPC（原子快照），**一个请求**。      |

既有 `/api/health`、`/api/admin/storage/delete`、`/api/downloads/*` 保持不变；`requireUser/requireAdmin`  
在 D2 之后对 `disabled=true` 一律返回 `403 {code:'account_disabled'}`。

> 审计读：**不做** Worker 端点（D4），前端 admin JWT 直连 `audit_logs`（RLS `is_admin` 已放行）。

---

## 7. DB Migration `0006_admin_console.sql` 内容清单（无破坏性变更）

1. `is_admin()` 语义扩展（§4.4.1，`security definer` + join profiles 校验 `disabled=false`）。
2. `guard_profile_disabled` 触发器改写（§4.4.2，自禁拒绝 / 受控通道豁免）。
3. 新建 `admin_user_mutation(uuid,uuid,app_role,boolean)`（§4.3）+ 授权仅 `service_role`。
4. 新建 `admin_stats()`（security definer，仅 `service_role`；聚合 §6 统计口径，含 `SUM(images.file_size)`）。
5. `audit_logs.action` 加 CHECK allowlist（§5）；补索引 `(action, created_at desc)` 支撑审计筛选。
6. 幂等风格与 0003/0005 一致（`create or replace` / `drop trigger if exists`），仅新增文件，跑 `db:migrate` 应用。

---

## 8. 前端改动范围（收敛，不重构）

| 文件                                              | 改动                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/admin/api.ts`（新）                      | Worker admin 调用封装：`listAdminUsers / changeUserRole / setUserDisabled / getAdminStats`（带 session bearer、统一错误解码）。                                |
| `features/auth/AuthProvider.tsx`                | role 查询并行取本人 `profiles.disabled`；disabled → 身份按非 admin 处理并暴露 `isDisabled`（仅影响展示/守卫，不触碰任何业务查询通道）。                                               |
| `routes/pages/admin/AdminUsersPage.tsx`         | 用户表（Avatar/Name/Email/Role/Created/Status/Actions）；Change Role（user⇄admin，自禁/自降灰置并服务端兜底）；Disable/Enable；错误提示含 `account_disabled`/`LAST_ADMIN`。 |
| `routes/pages/admin/AdminDashboardPage.tsx`     | 统计卡（Assets/Images/Users/Storage Used）+ Recent Assets/Activity（复用既有查询）。                                                                         |
| `routes/pages/admin/AdminStoragePage.tsx`       | 只读卡：Used / Image Count / byLanguage；UI 标注 **"按数据库记录估算（SUM(images.file_size)），非 Storage 实查"**（D5）。                                              |
| `routes/pages/admin/AdminAuditLogsPage.tsx`     | 表格 Time/Actor/Action/Target/Metadata(JSON)，action 前缀筛选，admin JWT 直连（D4）。                                                                       |
| `components/layout/AdminLayout.tsx` + `App.tsx` | 侧栏去掉 Settings；删除 `/admin/settings` 路由与 `AdminSettingsPage` 占位。                                                                                 |
| 用户端                                             | 不新增路由/功能；仅处理 `account_disabled` 提示（下载面板等既有失败分支文案覆盖）。                                                                                           |

---

## 9. 附加约束 → 落地核对表

| 评审约束                          | 落地位置                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| self-disable / self-demote 禁止 | DB 函数规则（§4.3）+ 触发器第一支（§4.4.2）+ UI 置灰                                    |
| 原子化 last-admin 保护             | advisory xact lock + 单事务函数（§4.2–4.3）；无任何"COUNT→UPDATE"客户端/服务端序列         |
| 变更前重读实际 role/status           | 函数在锁内重读 actor/target（§4.3 步骤 1–2）                                       |
| 单一 stats 端点                   | `GET /api/admin/stats` + `admin_stats()`（§6）；Dashboard 与 Storage 同源一个请求 |
| 审计 action 固定服务端 allowlist     | 端点语义固定 + DB 函数内枚举 + `audit_logs.action` CHECK（§5）                       |
| 保留 Phase 2–6 不变量              | 不改 user_roles RLS/GRANT；Assets/Tags/Search/Download 零改动；仅新增收紧性触发器与函数    |
| 不重构 Assets/Tags admin         | Out of Scope（§3）                                                        |
| 不加 Settings                   | 路由、侧栏、占位页全移除                                                            |
| 先推 5a193cb                    | 已完成（`edf1bf0..5a193cb`）                                                 |

---

## 10. Files / Impact / Acceptance

- **Files**：`supabase/migrations/0006_admin_console.sql`（新）、`worker/index.ts`、  
  `src/features/admin/api.ts`（新）、`AuthProvider.tsx`、Admin 四页、`AdminLayout.tsx`、`App.tsx`、`types/database.ts`（若需）、本门禁文档。
- **Database Impact**：Migration 0006（函数/触发器/CHECK/索引；**无表结构变更**、无数据迁移）。
- **Security Impact**：Worker 全 /api 硬门禁 `disabled`；RLS 语义收紧（`is_admin` 含未禁用）；last-admin 原子保护；审计 allowlist。
- **Acceptance（Gate G7）**：Admin Login → Dashboard 数字正确（含 storage 标注口径）→ Users（列表/改角色/禁用/启用/自操作拒绝/最后管理员保护全绿）→ Assets/Tags 管理不受影响 → Storage 只读视图 → Audit 视图可查含 `user.*` 新动作 → Phase 2–6 不变量回归通过 → 部署后线上 E2E 通过。
- **Dependencies**：`.env` 密钥齐备；`wrangler secret SUPABASE_SERVICE_ROLE_KEY` 已注入；生产库 migration 0001–0005 已应用。

## 11. 实施顺序（Owner 确认后执行）

1. 按 §7 写 `0006` → `db:migrate` → 冒烟（§4.5 用例 1–12）。
2. Worker：`authenticate()` 加 disabled 门禁 → 4 个 admin 端点（D3 先核实 GoTrue 契约）。
3. 前端：admin/api 模块 → AuthProvider → 四页实装 → 侧栏/路由收敛。
4. typecheck + build → 本地/线上安全测试（临时用户、并发交叉互禁、最后管理员负样本、白名单外审计直插）。
5. 结束报告（Implemented / Changed / Tests / Known Issues / Gate G7 判定）→ 部署 → Git（commit + push）。

---

## 12. 实施记录 / 裁决（2026-09-03，批次 A 后增补 —— 对 QA 与结束报告具有约束力）

**A1（语义裁决，§4.5 用例 #5）**：并发交叉互禁实测为**恰一个成功、败者 `FORBIDDEN`**（非 `LAST_ADMIN`）。根因：D6 强制"锁内重读 actor 须为活跃 admin"——胜者先提交使败者 `disabled=true`，败者在 advisory lock 释放后重读自身为非活跃 admin，被 `FORBIDDEN` 分支更早拒绝，普查分支不可达。"绝无 0 活跃 admin"由结构保证：每个变更都要求一个 ≠target 的活跃 admin 作为 actor，且自禁/自降被禁，系统无法归零。`LAST_ADMIN` raise 经人工负样本（actor 为无 profile 行的 admin，使普查集合与 actor 集合解耦）单独证明可达。**裁决：维持现语义（更严格，贴合"禁用=立即失去全部能力"），不改实现。**

**A2（计数勘误，§5）**：allowlist 全集实为 **18 项**（既有代码可写动作 15 项、生产存量数据 12 项），非"19 项"；0006 以枚举清单为准落地 18 项 CHECK。S0 存量核对：全部 12 个 distinct action ⊆ allowlist，无越界。

**A3（批次 A 结果）**：0006 已写并终审通过；先在一次性隔离验证库（已 DROP 清理）全量应用 0001→0006 并冒烟 37/37 PASS（含 §4.5 用例 1–12、并发交叉互禁、LAST_ADMIN 负样本、no-op 跳审计、白名单外直插拒绝、RLS 直连拒绝）；随后 `npm run db:migrate` 应用到生产（仅 0006），只读 sanity 全过（service_role 调 `admin_stats()` 成功返回真实数据）。证据：`docs/phase-7/evidence/0006-smoke.md`。

**A4（批次 B 结果与契约裁决）**：Worker 已落地且 `tsc -p tsconfig.worker.json`=0（证据：`docs/phase-7/evidence/worker-endpoints.md`）。对前端(#3)/QA(#4) 生效的裁决：
1. `GET /api/admin/users` 返回**自包含 envelope** `{users:[{id,email,display_name,role,disabled,created_at,last_sign_in_at}], total, page, per_page}`（§6 字面数组调整为 envelope：分页 total 需送达浏览器端，避免为响应头单开 CORS 暴露；字段与 §6 一致，符合"分页按实例实际契约"）。
2. join 缺 `user_roles` 行时列表兜底 `role:'user'`——仅展示层防御，无权限放大；真实裁决仍在 DB 函数锁内。
3. 会话撤销通道 = `POST {SUPABASE_URL}/auth/v1/admin/users/{id}/logout`（D3 实测：本实例 `/sessions*` 均 404，仅 `/logout` 可用）；disabled 端点**先原子落库、成功后再 best-effort 撤销**，失败仅日志、不回滚、不阻塞。
4. RPC 错误→HTTP 映射固化：`SELF_DEMOTE_FORBIDDEN`/`SELF_DISABLE_FORBIDDEN`/`FORBIDDEN`→403 `{code:'forbidden'}`；`LAST_ADMIN`→409 `{code:'last_admin'}`；`TARGET_NOT_FOUND`→404 `{code:'not_found'}`；非法 body/role/disabled/userId→400 `{code:'bad_request'}`；其余→502 `{code:'upstream_error'}`。

**A5（批次 C 结果与裁决）**：前端收敛完成（typecheck/build 0 错误；证据：`docs/phase-7/evidence/frontend.md`）。裁决：
1. Dashboard 不做 Recent Assets/Activity（批次 C 规格中为可选项）；Dashboard 与 Storage 各**仅一次** `getAdminStats()`（单一端点口径成立）。
2. AuthProvider 对 `disabled=true` 将**生效 role 折叠为 `'user'`**（不额外改动守卫文件），并暴露 `disabled`/`isDisabled`；仅身份/守卫层生效，不触碰业务查询通道。
3. Profile 页不加禁用徽标（不在 §8 文件清单内）。
4. 用户端仅 downloads/api.ts 增补 403 `account_disabled` 中文文案（§8 最小覆盖）。
5. **安全闭包核对（QA 权限矩阵必测）**：0001 `profiles` UPDATE 策略为 `using (id = auth.uid())`（仅本人行）——任何客户端（含活跃 admin）都无法直接改他人 `disabled`；他人 disabled 唯一可写通道 = service_role RPC（advisory lock + 普查）；自禁/自愈均由 0006 触发器拒绝。故"唯一写入通道"在 RLS 层成立，无旁路。

**A6（QA 收口裁决，DEF-1/DEF-2，2026-09-03，批次 D 后增补）**：

1. **DEF-1（pre-existing · 中 · 不修复、不阻塞本 Gate，排期 Backlog）**：`0001_initial_schema.sql` 的 `tags` 表无 `updated_at` 列，但 `touch_tags_upd` 触发器（L165）引用它。QA 以三条独立路径证实：隔离库 0001→0006 复现、**0001→0005 对照库同样复现（先于 Phase 7 存在）**、生产只读核对（`tags` 列 = id/name/slug/created_at 无 updated_at，且触发器存在）。裁决依据：Phase 7 未触碰 tags；Gate G7 的 Phase 2–6 回归以对照库基线证明"0006 无行为变化"，而非证明"Tags UPDATE 本身可用"；Owner 约束"不借机改 Assets/Tags"。修复方向（后续 migration 补 `updated_at timestamptz not null default now()` 或按 D4 语义删 `touch_tags_upd`）记录于结束报告 §Follow-up。
2. **DEF-2（cosmetic · 低 · 立即修复后再发布）**：`worker/index.ts` L114-116 `authErrBody` 在 `auth.code` 未定义时回退 `'unauthorized'`，使 authenticate() 三条 500 路径（service role key 缺失 / role 查询失败 / profile 查询失败）渲染为 `500 {code:'unauthorized'}`，状态与 code 不一致。裁决修复：回退规则改为按状态推导 `auth.code ?? (auth.status >= 500 ? 'internal' : 'unauthorized')`——401 无 code 仍 'unauthorized'、403 `account_disabled` 保留、500 渲染 'internal'。前端 `toUserMessage` default 分支兜底（显示服务端 message 或 HTTP 状态），无需新增 code 映射。由批次 B 工程师修复并 `npm run typecheck`=0 后，随任务 #5 统一部署。










