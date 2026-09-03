# Phase 7 · Migration 0006 隔离库冒烟 + 生产应用 — 证据

> 批次：A（DB 批次） · 执行：软件工程师（寇豆码） · 日期：2026-09-03
> 依据：`docs/phase-7/01-design-gate.md`（D6 修订版）§4.2–4.5 / §5 / §7 / §9 / §10
> 状态：**S0 预检 PASS · S1 0006 已写 · S2 隔离库冒烟全绿（37/37）· S3 生产应用 + 只读 sanity PASS**
> 红线核对：未 git add/commit/push；未改动 0001–0005 / src/ / worker/ / scripts/；未在验证库外创建/删除真实用户或改动真实行；`.env` 值全程未落盘/回显（连接信息一律打码）。

---

## 0. 产物清单

| 项 | 路径 | 说明 |
| --- | --- | --- |
| 迁移文件 | `supabase/migrations/0006_admin_console.sql` | is_admin 收紧 / guard_profile_disabled 三段式 / admin_user_mutation / admin_stats / audit action CHECK + 索引（全部幂等） |
| 证据文档 | `docs/phase-7/evidence/0006-smoke.md` | 本文件 |

---

## 1. 0006 关键 SQL 摘录

### 1.1 is_admin() 语义扩展（join profiles 校验 disabled=false）
```sql
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid()
      and ur.role = 'admin'
      and p.disabled = false
  );
$$;
```

### 1.2 guard_profile_disabled 触发器改写（三段式，先 drop 再重建）
```sql
create or replace function public.guard_profile_disabled() returns trigger
language plpgsql as $$
begin
  if new.disabled is distinct from old.disabled then
    if auth.uid() = new.id and new.disabled then
      raise exception 'SELF_DISABLE_FORBIDDEN: self-disable is not allowed';
    end if;
    if not ( current_user in ('postgres', 'service_role')
             or public.is_admin() ) then
      raise exception 'CHANGING_DISABLED_REQUIRES_ADMIN: only an active admin or a server-side channel may change disabled';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_disabled_upd on public.profiles;
create trigger guard_profile_disabled_upd
  before update on public.profiles
  for each row execute function public.guard_profile_disabled();
```

### 1.3 admin_user_mutation 原子门槛 + last-admin 普查子查询
```sql
  -- 原子门槛：常量键事务级咨询锁
  perform pg_advisory_xact_lock(hashtext('acmerd_admin_mutation')::bigint);

  -- (4) 原子化 last-admin 普查
  if v_tgt_role = 'admin'::app_role
     and not v_tgt_dis
     and (v_final_role = 'user'::app_role or v_final_dis)
     and not exists (
       select 1
       from public.user_roles ur2
       join public.profiles p2 on p2.id = ur2.user_id
       where ur2.user_id <> p_target
         and ur2.role = 'admin'::app_role
         and p2.disabled = false
     ) then
    raise exception 'LAST_ADMIN: operation would leave no active admin';
  end if;
```

### 1.4 审计 action 固定枚举（函数内） + 权限
```sql
-- 函数内：role 变更 → user.role_changed；disabled=true → user.disabled；disabled=false → user.enabled
revoke all on function public.admin_user_mutation(uuid, uuid, app_role, boolean) from public;
grant  execute on function public.admin_user_mutation(uuid, uuid, app_role, boolean) to service_role;

revoke all on function public.admin_stats() from public;
grant  execute on function public.admin_stats() to service_role;
```

### 1.5 audit_logs.action CHECK allowlist（DO 块防重）
```sql
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'audit_logs'
      and c.conname = 'audit_logs_action_allowlist'
  ) then
    alter table public.audit_logs
      add constraint audit_logs_action_allowlist
      check (action in (
        'asset.created','asset.updated','asset.deleted','asset.published','asset.unpublished',
        'asset.archived','asset.restored','image.uploaded','image.deleted',
        'tag.created','tag.updated','tag.deleted','asset.tag_added','asset.tag_removed',
        'download_source.updated','user.role_changed','user.disabled','user.enabled'
      ));
  end if;
end;
$$;
create index if not exists audit_logs_action_created_idx
  on public.audit_logs (action, created_at desc);
```

---

## 2. S0 — 生产库只读预检

- 连接：`postgresql`/直连 Supabase（非 6543 事务池），库名 `postgres`。连接信息打码。
- 当前角色：`postgres`，`rolsuper=false`，`rolcreatedb=true`，`rolcreaterole=true`，`rolbypassrls=true`；`transaction_read_only=off`；PG 17.6。
- 角色存在性：`anon/authenticated/service_role/authenticator` 均存在（集群级）。
- `SET ROLE authenticated` 探针：**OK**（postgres 是 authenticated 成员）→ 隔离库可真实模拟 RLS。

### 2.1 存量 action 与 allowlist 比对

生产 `audit_logs` 存量 62 行、**12 个 distinct action**：

```
asset.archived  asset.created  asset.deleted  asset.published  asset.restored
asset.tag_added asset.tag_removed  asset.updated  download_source.updated
image.deleted   image.uploaded  tag.created
```

比对 §5 清单（18 项枚举，见下方偏差说明）：**全部 ⊆ allowlist，无越界项** → 加 CHECK 安全，未触发"强行加 CHECK"红线。

> 偏差记录：§5 文案写"既有 16 + 新增 3 = 19"，但实际代码可产生审计动作 15 项、**枚举清单恰好 18 项**（第 19 项不存在）。0006 以 §5 枚举清单为准落地 18 项 CHECK；生产存量 12 项全部命中清单，已核对无误。

---

## 3. S2 — 隔离验证库冒烟（一次性库 `acmerd_phase7_gate_*`，已 DROP 清理）

- 建库可行（rolcreatedb=true + 直连 5432 会话模式）→ 采用首选路径。
- 一次性库为全新库（仅 public schema），先建**极简 Supabase 桩**：`auth` schema + `auth.uid()`（读 `request.jwt.claim.sub` GUC）+ `auth.users` 空壳 + `storage.buckets/objects` 空壳 + RLS 使能 + anon/authenticated/service_role 授权（镜像真实 Supabase，含 `USAGE ON SCHEMA auth`，否则 RLS 策略内 `auth.uid()` 对 authenticated 求值会 `permission denied`）。
- 桩建好后**按文件名序应用 0001→0005→0006**，每文件一条多语句 client.query（对齐 `scripts/db-apply.mjs`），并记录 `schema_migrations`。全部 `apply OK`。
- 冒烟用一次性测试用户：A/B = admin，U/C = user，X = 无 profile 的 admin（仅 LAST_ADMIN 分支样本用），均在库内创建即删，无残留。

### 3.1 §4.5 用例 1–12 结果（全部 PASS）

| # | 场景 | 结果 | 关键输出摘录 |
| --- | --- | --- | --- |
| 1 | 唯一 admin 自降级 | **PASS** | `SELF_DEMOTE_FORBIDDEN: self-demote is not allowed`；A 仍为活跃 admin |
| 2 | 唯一 admin 自禁用 | **PASS** | `SELF_DISABLE_FORBIDDEN: self-disable is not allowed` |
| 3 | user 降级唯一 admin | **PASS** | `FORBIDDEN: actor is not an active admin`；A 仍为活跃 admin |
| 4 | 2 活跃 admin：A 禁 B | **PASS** | 放行；B role=admin + disabled=true；活跃 admin 剩 1；审计 `user.disabled` actor=A target=B，metadata `disabled_from:false→to:true`、含 actor |
| 5 | 2 活跃 admin：A 禁 B ∥ B 禁 A | **PASS** | **恰一个成功**；败者 `FORBIDDEN`；并发后活跃 admin = 1（无归零锁死）。详见 3.2 |
| 6 | A 禁 B 后 A 再自禁 | **PASS** | `SELF_DISABLE_FORBIDDEN` |
| 7 | A 禁普通 user U | **PASS** | 放行；审计 `user.disabled` target=U actor=A；活跃 admin 仍 2 |
| 8 | 被禁 admin 直连改 assets/上传 | **PASS** | UPDATE assets=0 行；INSERT assets 报 `new row violates row-level security policy`；draft asset SELECT 不可见；Storage INSERT 报 RLS 拒绝；Storage UPDATE=0 行；对照组活跃 admin B UPDATE=1 行 |
| 9 | 被禁 admin 自助解禁 | **PASS** | `CHANGING_DISABLED_REQUIRES_ADMIN`；A 仍 disabled=true（禁止自愈） |
| 10 | B 启用 A（A 已禁） | **PASS** | 放行 + 审计 `user.enabled`（disabled_from:true→to:false，actor=B）；A 恢复能力（UPDATE assets=1 行） |
| 11 | action 白名单外直插 | **PASS** | 报 `violates check constraint "audit_logs_action_allowlist"`；对照组 allowlist 内 action 可写 |
| 12 | 每次变更审计齐全 | **PASS** | 4 条审计：`user.role_changed×2 / user.disabled / user.enabled`，均含 actor + role_from/to + disabled_from/to，target_type='profiles' |

### 3.2 并发 #5 时间线（advisory lock 串行化实证）

```
请求1 A→disable B : 成功（耗时 425ms）
请求2 B→disable A : FORBIDDEN（耗时 427ms，等待锁后重读发现自身已被禁 → actor 非活跃 admin）
并发后活跃 admin 计数 = 1（绝不归零）
```

- **断言达成**：恰一个成功、另一个被拒；系统层无"双双提交 → 0 活跃 admin"。
- **与门禁文案的偏差（重要，见 §5 风险）**：败者的错误码是 `FORBIDDEN` 而非门禁 §4.5 #5 期望的 `LAST_ADMIN`。根因：D6 强制"锁内重读 actor 必须活跃 admin"——胜者先禁用败者，败者重读自身 `disabled=true` → 直接 `FORBIDDEN`，普查分支根本走不到。这是设计自洽且更严格的语义（并发交叉互禁的败者本就不再是活跃 admin）。
- **LAST_ADMIN 分支本身已单独证明可达**（见 3.4 用例 #XB：当普查真归零时函数确实抛 `LAST_ADMIN`）。

### 3.3 补充用例（全部 PASS）

| ID | 场景 | 结果 | 摘录 |
| --- | --- | --- | --- |
| XA | 同值 no-op 跳过审计 | **PASS** | 重复 disable 已禁 B：`disabled_changed=false`，审计行数不增（1→1） |
| XB | LAST_ADMIN 分支（人工归零负样本） | **PASS** | 构造"无 profile 的 admin X 作为 actor"（actor 左连接通过、普查内连接不计入），对唯一活跃 admin A 执行 disable → `LAST_ADMIN: operation would leave no active admin` |
| XC | 普查子查询语义 | **PASS** | 唯一活跃 admin → `census_zero=true`；两名活跃 admin → `census_zero=false` |
| XD | admin_stats() service_role 可执行、结构完整 | **PASS** | 返回 7 键齐全；`storageUsedBytes=1024 / totalImages=1 / imagesByLanguage.en=1` |

> XB 场景为**人工构造**（admin 角色无 profiles 行），用途是让普查计数与 actor 集合解耦，直接证明 `LAST_ADMIN` raise 在"变更将清空活跃 admin"时真实触发；正常调用路径下活跃 admin 的 actor 本身即为普查中的"另一个活跃 admin"，故 `LAST_ADMIN` 不可达（由 FORBIDDEN 更早兜底）。

---

## 4. S3 — 生产应用 + 只读 sanity

### 4.1 应用
```
apply 0006_admin_console.sql ... OK
migration complete
```
（0001–0005 均已记录、skip；schema_migrations 已记录 `0006_admin_console.sql`。）

### 4.2 只读 sanity（全部通过，未做任何破坏性变更/未创建残留用户）
- `schema_migrations`：0006 已记录（applied_at 2026-09-03）。
- `is_admin`：security definer + stable ✓
- `guard_profile_disabled_upd` trigger 存在（仅 1 个，幂等）✓
- `admin_user_mutation(uuid,uuid,app_role,boolean)` security definer ✓（args 确认为 `uuid,uuid,app_role,boolean`）
- `admin_stats()` security definer ✓
- 约束 `audit_logs_action_allowlist` 存在 ✓；索引 `audit_logs_action_created_idx` 存在 ✓
- **service_role RPC `admin_stats()`（supabase-js，只读聚合）**：成功，7 键齐全，真实数据
  ```json
  {"totalUsers":1,"totalAssets":1,"totalImages":1,"disabledUsers":0,
   "assetsByStatus":{"published":1},"imagesByLanguage":{"en":1},"storageUsedBytes":917700}
  ```

---

## 5. 偏差与风险（上报项）

1. **门禁 #5 期望 `LAST_ADMIN` vs 实际 `FORBIDDEN`（语义说明，非缺陷）**：D6 的"锁内重读 actor 须为活跃 admin"使得并发交叉互禁的败者在等锁后被识别为已禁用 → 抛 `FORBIDDEN` 而不是 `LAST_ADMIN`。安全性质不变（绝无 0 活跃 admin）；`LAST_ADMIN` 分支已用 #XB 人工负样本单独证明可达。若团队坚持门禁字面期望，需要重新设计 actor 判定语义（建议不采纳，当前语义更严格、更贴合"禁用=立即失去全部能力"）。
2. **§5 文案计数笔误**："19 项 / 既有 16" 与枚举清单（18 项）不符；0006 以枚举清单为准。存量数据核对无越界，加 CHECK 安全。
3. **0006 只新增/收紧**：未触碰 0001–0005 / src / worker / scripts；无表结构变更、无数据迁移；全部语句幂等（0006 可安全重放，S3 sanity 已核对触发器仅 1 份）。
4. **隔离库已清理**：`acmerd_phase7_gate_*` 全部 DROP（含早前迭代遗留库），生产库无残留测试用户/行。

---

## 6. 环境与核对（非秘密）

- 生产角色 `postgres`（rolcreatedb=true、rolbypassrls=true、成员 anon/authenticated/service_role）；service_role 具 BYPASSRLS（Supabase 标准语义）。
- 迁移执行器为 `npm run db:migrate`（scripts/db-apply.mjs，简单查询协议多语句，按文件名序）。
