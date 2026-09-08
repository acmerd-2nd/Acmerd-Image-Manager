-- ============================================================
-- 0017: V1.3.1 — Schedule 进度三状态 + adjust_credits 扩展 operation
-- 依据: docs/v1.3.1/01-design-gate.md G1/G3/G4（Owner 2026-09-07 全批）
--
--   G1: schedule_items 加列 progress（not_started/in_progress/completed，
--       default 'not_started'；与发布态 status 正交）
--       published_schedule_items 视图末列补 progress（排序不变）
--   G3: adjust_credits 加可选 p_operation（默认 null）→ ledger metadata.operation
--       （向后兼容：既有 6 参调用不受影响）
--   G4: admin_batch_adjust_credits —— SECURITY DEFINER，函数内逐用户
--       校验+adjust，任一失败 raise → 整体回滚 = 整批原子（Gate G4 方案 A）
--
-- 幂等：IF NOT EXISTS / drop policy if exists / create or replace。
-- 不变量：collections / credits RLS / audit allowlist 零改动。
-- ============================================================

-- ------------------------------------------------------------
-- (1) schedule_items.progress
-- ------------------------------------------------------------
alter table public.schedule_items
  add column if not exists progress text not null default 'not_started';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'schedule_items_progress_check' and conrelid = 'public.schedule_items'::regclass
  ) then
    alter table public.schedule_items
      add constraint schedule_items_progress_check
      check (progress in ('not_started', 'in_progress', 'completed'));
  end if;
end $$;

-- ------------------------------------------------------------
-- (2) published_schedule_items 视图重建（progress 末列；排序不变）
-- ------------------------------------------------------------
create or replace view public.published_schedule_items
with (security_invoker = true) as
select
  id,
  title,
  description,
  event_date,
  sort_order,
  progress
from public.schedule_items
where status = 'published'
order by event_date asc nulls last, sort_order asc;

grant select on public.published_schedule_items to anon, authenticated;

-- ------------------------------------------------------------
-- (3) adjust_credits：+ 可选 p_operation → ledger metadata.operation
--     （create or replace；新参数带默认值，既有调用兼容）
-- ------------------------------------------------------------
create or replace function public.adjust_credits(
  p_user_id  uuid,
  p_balance  numeric,
  p_reason   text default null,
  p_actor_id uuid default null,
  p_operation text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old       numeric(12,2);
  v_new       numeric(12,2);
  v_unlimited boolean;
begin
  if p_balance is null or p_balance < 0 then
    raise exception 'INVALID_BALANCE: balance must be >= 0';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'FORBIDDEN: adjust_credits requires admin or service role';
  end if;

  select balance, unlimited into v_old, v_unlimited
    from public.credit_accounts
   where user_id = p_user_id;
  if not found then
    raise exception 'CREDIT_ACCOUNT_MISSING: user % has no credit account', p_user_id;
  end if;

  update public.credit_accounts
     set balance = p_balance
   where user_id = p_user_id
  returning balance into v_new;

  insert into public.credit_transactions
    (user_id, type, amount, balance_after, reference_type, reference_id, metadata)
  values
    (p_user_id, 'admin_adjustment', v_new - v_old, v_new, 'profile', p_user_id::text,
     jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason, 'actor', p_actor_id,
                        'operation', coalesce(p_operation, 'set_balance')));

  return v_new;
end;
$$;

revoke all on function public.adjust_credits(uuid, numeric, text, uuid, text) from anon, authenticated;

-- 删除旧 4 参签名（避免重载解析歧义；4 参调用自动落到 5 参版本，p_operation 取默认 null）
drop function if exists public.adjust_credits(uuid, numeric, text, uuid);

-- ------------------------------------------------------------
-- (4) admin_batch_adjust_credits —— 整批原子（G4 方案 A）
--     SECURITY DEFINER；函数内两段循环（先全部 SELECT FOR UPDATE 校验，
--     再逐个 update+写流水），任一失败 raise → 单事务整体回滚。
--     权限：service_role or is_admin（Worker 持 Secret 调用）。
-- ------------------------------------------------------------
create or replace function public.admin_batch_adjust_credits(
  p_user_ids uuid[],
  p_delta    numeric,
  p_reason   text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid;
  v_old  numeric(12,2);
  v_new  numeric(12,2);
  v_n    int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'FORBIDDEN: batch adjust requires admin or service role';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'INVALID_DELTA: delta must be non-zero';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) = 0 then
    raise exception 'INVALID_USER_IDS: empty list';
  end if;
  if array_length(p_user_ids, 1) > 100 then
    raise exception 'TOO_MANY_USERS: batch limit is 100';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED';
  end if;

  -- 第一段：全部锁定并校验（缺账户 / 调成负数 → 任一失败即整批失败）
  foreach v_uid in array p_user_ids loop
    select balance into v_old from public.credit_accounts
      where user_id = v_uid for update;
    if not found then
      raise exception 'CREDIT_ACCOUNT_MISSING: user % has no credit account', v_uid;
    end if;
    if v_old + p_delta < 0 then
      raise exception 'INSUFFICIENT_CREDITS: user % balance % below delta %', v_uid, v_old, p_delta;
    end if;
  end loop;

  -- 第二段：逐用户 update + 流水（同一事务）
  foreach v_uid in array p_user_ids loop
    update public.credit_accounts
       set balance = balance + p_delta
     where user_id = v_uid
    returning balance into v_new;
    insert into public.credit_transactions
      (user_id, type, amount, balance_after, reference_type, reference_id, metadata)
    values
      (v_uid, 'admin_adjustment', p_delta, v_new, 'profile', v_uid::text,
       jsonb_build_object('reason', p_reason, 'actor', p_actor_id, 'operation', 'batch'));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('adjusted', v_n, 'delta', p_delta);
end;
$$;

revoke all on function public.admin_batch_adjust_credits(uuid[], numeric, text, uuid) from anon, authenticated;

-- ============================================================
-- 0017 end. 幂等可重放；既有 RLS / allowlist 零改动。
-- ============================================================
