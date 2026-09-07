-- ============================================================
-- 0016: V1.2 B — Schedule 内容编排（schedule_items）
-- 依据: docs/v1.2/01-design-gate.md §2 D6/D7/D8（Owner 2026-09-07 批准）
--
--   D6 字段最小集: title / event_date / description / status / sort_order
--     （不加 URL/封面/时间段——未来需要走 Change Proposal）
--   D7 公开语义: published_schedule_items 视图（security_invoker）只吐 published，
--     event_date asc, sort_order asc；RLS 镜像 0012 collections 三政策；
--     与导航开关解耦（开关只控导航显隐，页面有内容可直访）
--   D8 审计: schedule.item_created/updated/deleted/published/archived
--     （0003/0012 状态化范式）；同文件扩 allowlist 38 → 43
--
-- 幂等: create if not exists / drop policy if exists / create or replace /
--       allowlist DO 块防窄化守卫（同 0013/0014 先例）。
-- 不变量: 既有表 RLS / published_assets / published_collections 零改动。
-- ============================================================

-- ------------------------------------------------------------
-- (1) 表（0001/0009 范式；created_by 同 collections 引 profiles）
-- ------------------------------------------------------------
create table if not exists public.schedule_items (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  event_date  date,
  status      text not null default 'draft'
              check (status in ('draft', 'published', 'archived')),
  sort_order  int  not null default 0,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_schedule_items_sort
  on public.schedule_items (event_date, sort_order);

drop trigger if exists touch_schedule_items_upd on public.schedule_items;
create trigger touch_schedule_items_upd
  before update on public.schedule_items
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- (2) RLS（镜像 0012 collections 三政策）
-- ------------------------------------------------------------
alter table public.schedule_items enable row level security;

drop policy if exists "schedule_items select published or admin" on public.schedule_items;
create policy "schedule_items select published or admin" on public.schedule_items
  for select using (status = 'published' or public.is_admin());

drop policy if exists "schedule_items insert admin" on public.schedule_items;
create policy "schedule_items insert admin" on public.schedule_items
  for insert with check (public.is_admin());

drop policy if exists "schedule_items update admin" on public.schedule_items;
create policy "schedule_items update admin" on public.schedule_items
  for update using (public.is_admin());

drop policy if exists "schedule_items delete admin" on public.schedule_items;
create policy "schedule_items delete admin" on public.schedule_items
  for delete using (public.is_admin());

-- ------------------------------------------------------------
-- (3) published_schedule_items 视图（security_invoker，D7）
-- ------------------------------------------------------------
create or replace view public.published_schedule_items
with (security_invoker = true) as
select
  id,
  title,
  description,
  event_date,
  sort_order
from public.schedule_items
where status = 'published'
order by event_date asc nulls last, sort_order asc;

grant select on public.published_schedule_items to anon, authenticated;

-- ------------------------------------------------------------
-- (4) 审计（0012 范式：created/deleted 泛化 + 状态化函数 + WHEN 互斥 updated）
--     is_admin() 过滤——service role 直写不产生审计行，Worker 直写审计场景
--     由 Worker 层负责（同 0006/0012 先例）。
-- ------------------------------------------------------------
drop trigger if exists audit_schedule_items_ins on public.schedule_items;
create trigger audit_schedule_items_ins
  after insert on public.schedule_items
  for each row execute function public.write_audit('schedule.item_created');

drop trigger if exists audit_schedule_items_del on public.schedule_items;
create trigger audit_schedule_items_del
  after delete on public.schedule_items
  for each row execute function public.write_audit('schedule.item_deleted');

create or replace function public.audit_schedule_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    return null;
  end if;
  if new.status = 'published' then
    insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values (auth.uid(), 'schedule.item_published', 'schedule_items', new.id::text,
            jsonb_build_object('from', old.status, 'to', new.status));
  elsif new.status = 'archived' then
    insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
    values (auth.uid(), 'schedule.item_archived', 'schedule_items', new.id::text,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists audit_schedule_status on public.schedule_items;
create trigger audit_schedule_status
  after update of status on public.schedule_items
  for each row
  when (old.status is distinct from new.status)
  execute function public.audit_schedule_status_change();

drop trigger if exists audit_schedule_items_upd on public.schedule_items;
create trigger audit_schedule_items_upd
  after update on public.schedule_items
  for each row
  when (old.status is not distinct from new.status)
  execute function public.write_audit('schedule.item_updated');

-- ------------------------------------------------------------
-- (5) allowlist 38 → 43（严格超集，DO 块 + 防窄化守卫，同 0013/0014）
--     新增: schedule.item_created/updated/deleted/published/archived
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.audit_logs
    where action not in (
      'asset.created','asset.updated','asset.deleted','asset.published','asset.unpublished',
      'asset.archived','asset.restored',
      'image.uploaded','image.updated','image.deleted',
      'tag.created','tag.updated','tag.deleted',
      'asset.tag_added','asset.tag_removed',
      'asset_language.created','asset_language.updated','asset_language.deleted',
      'asset_language.published','asset_language.unpublished',
      'user.role_changed','user.disabled','user.enabled',
      'download_source.updated',
      'collection.created','collection.updated','collection.deleted',
      'collection.published','collection.archived',
      'credits.adjusted','credits.unlimited_changed',
      'user.provisioned','user.deleted',
      'settings.updated',
      'github.upload.failed','github.upload.recovered',
      'github.delete.retry','github.orphan.purged'
    )
  ) then
    raise notice '0016 allowlist rebuild skipped: existing actions beyond the 38-item set';
    return;
  end if;
  alter table public.audit_logs drop constraint if exists audit_logs_action_allowlist;
  alter table public.audit_logs
    add constraint audit_logs_action_allowlist
    check (action in (
      'asset.created','asset.updated','asset.deleted','asset.published','asset.unpublished',
      'asset.archived','asset.restored',
      'image.uploaded','image.updated','image.deleted',
      'tag.created','tag.updated','tag.deleted',
      'asset.tag_added','asset.tag_removed',
      'asset_language.created','asset_language.updated','asset_language.deleted',
      'asset_language.published','asset_language.unpublished',
      'user.role_changed','user.disabled','user.enabled',
      'download_source.updated',
      'collection.created','collection.updated','collection.deleted',
      'collection.published','collection.archived',
      'credits.adjusted','credits.unlimited_changed',
      'user.provisioned','user.deleted',
      'settings.updated',
      'github.upload.failed','github.upload.recovered',
      'github.delete.retry','github.orphan.purged',
      'schedule.item_created','schedule.item_updated','schedule.item_deleted',
      'schedule.item_published','schedule.item_archived'
    ));
end;
$$;

-- ------------------------------------------------------------
-- (6) grants：anon/authenticated 对新表只读经视图；基表仅 service_role
--     （0002 范式：默认无 grant ⇒ 客户端无基表权限；RLS 双保险）
-- ------------------------------------------------------------
-- （无显式 grant = 维持 0002 default privilege 模型，视图已单独授权）

-- ============================================================
-- 0016 end. 幂等可重放；既有 RLS / 视图 / allowlist 38 项严格超集保留。
-- ============================================================
