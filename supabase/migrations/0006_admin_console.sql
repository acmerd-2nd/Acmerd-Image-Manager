-- ============================================================
-- 0006: Admin Console 安全收紧（Phase 7，Owner 批准的 Design Gate D6 修订版）
--
-- 五件事（全部只收紧 / 只新增，无表结构变更、无数据迁移，幂等）：
--   1. is_admin() 语义扩展：role='admin' AND profiles.disabled=false
--      （一处修改、全表生效：被禁 admin 的 assets/tags/download_sources/
--        audit_logs/profiles 管理读、直连 CRUD、Storage 上传/删除、
--        write_audit 全部立即失效 —— 禁用 = 完整失去管理能力）
--   2. guard_profile_disabled 触发器改写（三段式）：
--      自禁（auth.uid()=new.id 且 new.disabled=true）→ SELF_DISABLE_FORBIDDEN
--      非受控通道（current_user not in ('postgres','service_role')
--                 且非 is_admin()）→ CHANGING_DISABLED_REQUIRES_ADMIN
--      （被禁者自助解禁同样被拒 —— 禁止自愈）
--   3. public.admin_user_mutation(...) —— 原子用户变更唯一写入通道：
--      事务级 advisory lock + 锁内重读 actor/target + self 规则 +
--      原子化 last-admin 普查 + 固定枚举审计；仅授权 service_role。
--   4. public.admin_stats() —— 单一原子快照统计端点；仅授权 service_role。
--   5. audit_logs.action 固定 allowlist CHECK + (action, created_at desc) 索引。
--
-- 说明：§5 枚举全集（以清单为准）为 18 项；文案中"19 项/既有 16"系笔误，
--       实际既有代码可写审计动作 15 项（生产存量数据 12 项），全部 ⊆ 本清单。
-- ============================================================

-- ------------------------------------------------------------
-- (1) is_admin() 语义扩展
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- (2) guard_profile_disabled 触发器改写（先 drop 再重建）
--     注意：此触发器函数保持普通语言 plpgsql（非 security definer），
--           使 current_user 反映真实执行者，受控通道判定才有意义。
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- (3) admin_user_mutation —— 原子用户变更（D6 唯一写入通道）
--
-- 规则（函数内不可变）：
--   * p_actor 在锁内重读：必须是"活跃 admin"（role=admin 且未禁用）
--   * p_target 在锁内重读：不存在 → TARGET_NOT_FOUND
--   * self 规则：target=actor 且 p_role='user'  → SELF_DEMOTE_FORBIDDEN
--                target=actor 且 p_disabled=true → SELF_DISABLE_FORBIDDEN
--   * last-admin 普查：仅当目标当前为活跃 admin 且本操作将使其失去该身份时，
--     检查"除 target 外仍存在 ≥1 活跃 admin"，否则 LAST_ADMIN
--   * 同值 = no-op，跳过审计
--   * 审计 action 固定枚举：role 变更 → user.role_changed；
--     disabled=true → user.disabled；disabled=false → user.enabled
-- ------------------------------------------------------------
create or replace function public.admin_user_mutation(
  p_actor    uuid,
  p_target   uuid,
  p_role     app_role default null,
  p_disabled boolean  default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role app_role;
  v_actor_dis  boolean;
  v_tgt_role   app_role;
  v_tgt_dis    boolean;
  v_final_role app_role;
  v_final_dis  boolean;
begin
  -- 原子门槛：常量键事务级咨询锁；全系统同一时刻只允许一个"管理员普查类变更"在途
  perform pg_advisory_xact_lock(hashtext('acmerd_admin_mutation')::bigint);

  -- (1) 锁内重读 actor：必须是活跃 admin（role=admin 且未禁用）
  select ur.role, coalesce(p.disabled, false)
    into v_actor_role, v_actor_dis
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
   where ur.user_id = p_actor;
  if not found
     or v_actor_role is distinct from 'admin'::app_role
     or v_actor_dis then
    raise exception 'FORBIDDEN: actor is not an active admin';
  end if;

  -- (2) 锁内重读 target 实际状态（绝不信任调用方传入的"当前状态"）
  select ur.role, coalesce(p.disabled, false)
    into v_tgt_role, v_tgt_dis
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
   where ur.user_id = p_target;
  if not found then
    raise exception 'TARGET_NOT_FOUND';
  end if;

  -- (3) self 规则：自降级 / 自禁用永禁（含 admin）
  if p_target = p_actor and p_role = 'user'::app_role then
    raise exception 'SELF_DEMOTE_FORBIDDEN: self-demote is not allowed';
  end if;
  if p_target = p_actor and p_disabled = true then
    raise exception 'SELF_DISABLE_FORBIDDEN: self-disable is not allowed';
  end if;

  -- 计算变更后的有效值（null 字段 = 不变）
  v_final_role := coalesce(p_role, v_tgt_role);
  v_final_dis  := coalesce(p_disabled, v_tgt_dis);

  -- (4) 原子化 last-admin 普查：仅当目标当前为活跃 admin 且本操作使其失去该身份
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

  -- (5) 落变更（null 字段 = 不变；同值 = no-op，不写审计）
  if v_final_role is distinct from v_tgt_role then
    update public.user_roles
       set role = v_final_role
     where user_id = p_target;
  end if;
  if v_final_dis is distinct from v_tgt_dis then
    update public.profiles
       set disabled = v_final_dis
     where id = p_target;
  end if;

  -- (6) 审计：action 由函数内固定枚举决定；metadata 含 from/to/actor
  if v_final_role is distinct from v_tgt_role
     or v_final_dis  is distinct from v_tgt_dis then
    if v_final_role is distinct from v_tgt_role then
      insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
      values (
        p_actor, 'user.role_changed', 'profiles', p_target::text,
        jsonb_build_object(
          'actor', p_actor::text,
          'role_from', v_tgt_role::text,
          'role_to', v_final_role::text,
          'disabled_from', v_tgt_dis,
          'disabled_to', v_final_dis
        )
      );
    end if;
    if v_final_dis is distinct from v_tgt_dis then
      insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
      values (
        p_actor,
        case when v_final_dis then 'user.disabled' else 'user.enabled' end,
        'profiles', p_target::text,
        jsonb_build_object(
          'actor', p_actor::text,
          'role_from', v_tgt_role::text,
          'role_to', v_final_role::text,
          'disabled_from', v_tgt_dis,
          'disabled_to', v_final_dis
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'user_id',          p_target,
    'role',             v_final_role::text,
    'disabled',         v_final_dis,
    'role_changed',     v_final_role is distinct from v_tgt_role,
    'disabled_changed', v_final_dis  is distinct from v_tgt_dis
  );
end;
$$;

-- 仅 service_role 可执行（Worker 后端通道）
revoke all on function public.admin_user_mutation(uuid, uuid, app_role, boolean) from public;
grant  execute on function public.admin_user_mutation(uuid, uuid, app_role, boolean) to service_role;

-- ------------------------------------------------------------
-- (4) admin_stats —— 单一原子快照统计（Dashboard / Storage 共用）
--     口径：storageUsedBytes = SUM(images.file_size)（DB 记账估算，非 Storage 实查）
-- ------------------------------------------------------------
create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'totalAssets',      (select count(*) from public.assets),
    'assetsByStatus',   coalesce((
                          select jsonb_object_agg(status::text, cnt)
                          from (
                            select status, count(*) as cnt
                            from public.assets
                            group by status
                          ) s
                        ), '{}'::jsonb),
    'totalImages',      (select count(*) from public.images),
    'totalUsers',       (select count(*) from public.profiles),
    'disabledUsers',    (select count(*) from public.profiles where disabled),
    'storageUsedBytes', (select coalesce(sum(file_size), 0) from public.images),
    'imagesByLanguage', coalesce((
                          select jsonb_object_agg(lang.language_code, lang.cnt)
                          from (
                            select al.language_code, count(*) as cnt
                            from public.images i
                            join public.asset_languages al on al.id = i.asset_language_id
                            group by al.language_code
                          ) lang
                        ), '{}'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.admin_stats() from public;
grant  execute on function public.admin_stats() to service_role;

-- ------------------------------------------------------------
-- (5) audit_logs.action 固定 allowlist CHECK + 审计筛选索引
--     全集以 §5 清单为准（18 项；见文件头说明）。
--     DO $$ 块判 pg_constraint 防重（幂等）。
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'audit_logs'
      and c.conname = 'audit_logs_action_allowlist'
  ) then
    alter table public.audit_logs
      add constraint audit_logs_action_allowlist
      check (action in (
        'asset.created',
        'asset.updated',
        'asset.deleted',
        'asset.published',
        'asset.unpublished',
        'asset.archived',
        'asset.restored',
        'image.uploaded',
        'image.deleted',
        'tag.created',
        'tag.updated',
        'tag.deleted',
        'asset.tag_added',
        'asset.tag_removed',
        'download_source.updated',
        'user.role_changed',
        'user.disabled',
        'user.enabled'
      ));
  end if;
end;
$$;

create index if not exists audit_logs_action_created_idx
  on public.audit_logs (action, created_at desc);
