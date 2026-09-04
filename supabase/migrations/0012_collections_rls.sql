-- ============================================================
-- 0012: V1.1 Phase A — RLS / 视图 / 审计触发器（collections + credits）
-- 依据: docs/v1.1/01-design-gate.md (Rev B) §4 / §7 + 总纲权限安全模型
--
--   * collections: 读 published-or-admin，写 admin（沿用 0001 范式）
--   * published_collections 视图: 仅返回"含 ≥1 个双层 published Asset"
--     的 Collection（避免空壳暴露；Gate §7）
--   * credit_accounts: 本人只读；写零客户端（RPC/Worker 专属）
--   * credit_transactions: 本人 + admin 只读；写零客户端
--   * 审计: collection.created/updated/deleted/published/archived
--     （状态化审计沿用 0003 asset 范式；动作用于 0013 allowlist）
--
-- 不变量: 既有表的既有 RLS 策略零改动；published_assets 零改动。
-- 幂等: drop policy if exists + create policy / create or replace。
-- ============================================================

-- ------------------------------------------------------------
-- (1) RLS 启用
-- ------------------------------------------------------------
alter table public.collections        enable row level security;
alter table public.credit_accounts    enable row level security;
alter table public.credit_transactions enable row level security;

-- ------------------------------------------------------------
-- (2) collections 策略（0001 assets 同范式）
-- ------------------------------------------------------------
drop policy if exists "collections select published or admin" on public.collections;
create policy "collections select published or admin" on public.collections
  for select using (status = 'published' or public.is_admin());

drop policy if exists "collections insert admin" on public.collections;
create policy "collections insert admin" on public.collections
  for insert with check (public.is_admin());

drop policy if exists "collections update admin" on public.collections;
create policy "collections update admin" on public.collections
  for update using (public.is_admin());

drop policy if exists "collections delete admin" on public.collections;
create policy "collections delete admin" on public.collections
  for delete using (public.is_admin());

-- ------------------------------------------------------------
-- (3) credit_accounts / credit_transactions 策略
--     写零策略（ grants 已限 service_role，RLS 双保险）
-- ------------------------------------------------------------
drop policy if exists "credit_accounts select own" on public.credit_accounts;
create policy "credit_accounts select own" on public.credit_accounts
  for select using (user_id = auth.uid());

drop policy if exists "credit_transactions select own or admin" on public.credit_transactions;
create policy "credit_transactions select own or admin" on public.credit_transactions
  for select using (user_id = auth.uid() or public.is_admin());

-- ------------------------------------------------------------
-- (4) published_collections 视图（security_invoker，沿 0001 published_assets 范式）
--     语义: Collection published 且其下存在 ≥1 个双层 published Asset。
--     未归组 Asset 不进任何 Collection，首页"More Resources"区由
--     published_assets 直接承载（视图不动，零漂移面）。
-- ------------------------------------------------------------
create or replace view public.published_collections
with (security_invoker = true) as
select
  c.id,
  c.name,
  c.slug,
  c.description,
  c.cover_image_id,
  c.sort_order,
  count(a.id) as asset_count
from public.collections c
join public.assets a
  on a.collection_id = c.id and a.status = 'published'
where c.status = 'published'
  and exists (
    select 1 from public.asset_languages l
    where l.asset_id = a.id and l.status = 'published'
  )
group by c.id;

grant select on public.published_collections to anon, authenticated;

-- ------------------------------------------------------------
-- (5) collections 审计（状态化，0003/0007 范式）
--     created/deleted 走泛化 write_audit；status 变更走专用函数；
--     非 status 变更记 collection.updated（WHEN 排除 status 变更防双记）。
--     触发器经 is_admin() 过滤——service role 直写不产生审计行，
--     Worker 直写审计场景由 Worker 层负责（同 0006 先例）。
-- ------------------------------------------------------------
drop trigger if exists audit_collections_ins on public.collections;
create trigger audit_collections_ins
  after insert on public.collections
  for each row execute function public.write_audit('collection.created');

drop trigger if exists audit_collections_del on public.collections;
create trigger audit_collections_del
  after delete on public.collections
  for each row execute function public.write_audit('collection.deleted');

create or replace function public.audit_collection_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text;
begin
  if not public.is_admin() then
    return null;
  end if;

  -- asset_status: draft / published / archived（collections 复用）
  v_action := case
    when new.status = 'published' then 'collection.published'
    when new.status = 'archived'  then 'collection.archived'
    else null
  end;

  if v_action is null then
    return null;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), v_action, 'collections', new.id::text,
    jsonb_build_object('from', old.status, 'to', new.status)
  );
  return new;
end;
$$;

drop trigger if exists audit_collection_status on public.collections;
create trigger audit_collection_status
  after update of status on public.collections
  for each row
  when (old.status is distinct from new.status)
  execute function public.audit_collection_status_change();

drop trigger if exists audit_collections_upd on public.collections;
create trigger audit_collections_upd
  after update on public.collections
  for each row
  when (old.status is not distinct from new.status)
  execute function public.write_audit('collection.updated');

-- ============================================================
-- 0012 end. 幂等可重放；既有表 RLS / published_assets 零改动。
-- ============================================================
