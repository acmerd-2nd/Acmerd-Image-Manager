-- ============================================================
-- 0022: V1.5 Phase A — 360° 产品展示数据模型
-- 依据: docs/v1.5/02-design-gate.md（Owner 全批：D1–D6 按建议；指令 12 项）
--       产品规格 = 《360度资产展示.txt》（36/72/144/360 仅后台帧密度；
--       前台唯一「360° View」；与 Language/Download/Credits 解耦）
--
-- 内容:
--   (1) asset_360_sequences / asset_360_frames 两表（frame_count CHECK、
--       sequence_id+frame_index 唯一、四态+pending 帧状态）
--   (2) assets.active_360_sequence_id（FK on delete set null）+ 守卫触发器
--       （active 必须指向同 asset 且 ready 的序列——Gate D4 双保险）
--   (3) RLS：基表 select = ready（或 admin）——security_invoker 视图依赖；
--       写零策略 + grants 仅 service_role（0002 范式，Worker 独占）
--   (4) published_360 收敛视图（published asset ⋈ active ready sequence，
--       frames jsonb 按 frame_index 排序聚合——Gate §G6）
--   (5) audit allowlist 44 → 48（+360.sequence.created/activated/deleted/
--       360.upload.failed，幂等 DO 块 + 防窄化守卫）
--   (6) grants：基表 select anon/authenticated/service_role（RLS 过滤）；
--       写零授权（仅 service_role 走既有默认？——0002 模型：新表不 grant 写
--       ⇒ 客户端零写，与 schedule_items/0016 完全一致）
-- 幂等: create if not exists / drop policy if exists / create or replace /
--       add column if not exists / DO 块防窄化守卫（0013/0014/0016/0018 先例）。
-- 不变量: 既有表结构/RLS/视图/credits 零改动；published_assets 不动（D1：卡片角标不做）。
-- ============================================================

-- ------------------------------------------------------------
-- (1) 表
-- ------------------------------------------------------------
create table if not exists public.asset_360_sequences (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references public.assets(id) on delete cascade,
  frame_count  int  not null check (frame_count in (36,72,144,360)),
  status       text not null default 'draft'
               check (status in ('draft','uploading','ready','failed','deleting')),
  source_sha   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.asset_360_frames (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references public.asset_360_sequences(id) on delete cascade,
  frame_index  int  not null check (frame_index >= 1),
  provider     text not null default 'github' check (provider in ('github')),
  source_path  text not null,
  blob_sha     text,
  file_size    bigint,
  width        int,
  height       int,
  status       text not null default 'pending'
               check (status in ('pending','uploading','ready','failed','deleting')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (sequence_id, frame_index)
);

create index if not exists idx_360_sequences_asset on public.asset_360_sequences (asset_id, status);
create index if not exists idx_360_frames_sequence on public.asset_360_frames (sequence_id, frame_index);

drop trigger if exists touch_360_sequences_upd on public.asset_360_sequences;
create trigger touch_360_sequences_upd
  before update on public.asset_360_sequences
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_360_frames_upd on public.asset_360_frames;
create trigger touch_360_frames_upd
  before update on public.asset_360_frames
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- (2) assets.active_360_sequence_id + 守卫触发器（Gate D4）
--     注: 守卫对任何写者生效（含 postgres）；绕过 = disable trigger，仅限运维。
-- ------------------------------------------------------------
alter table public.assets
  add column if not exists active_360_sequence_id uuid
  references public.asset_360_sequences(id) on delete set null;

create or replace function public.guard_asset_360_active() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active_360_sequence_id is not null then
    if not exists (
      select 1 from public.asset_360_sequences s
      where s.id = new.active_360_sequence_id
        and s.asset_id = new.id
        and s.status = 'ready'
    ) then
      raise exception '360_ACTIVE_INVALID: active_360_sequence_id must reference a ready sequence of the same asset';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_asset_360_active_tr on public.assets;
create trigger guard_asset_360_active_tr
  before insert or update of active_360_sequence_id on public.assets
  for each row execute function public.guard_asset_360_active();

-- ------------------------------------------------------------
-- (3) RLS：基表 select = ready（或 admin）——security_invoker 视图的底层授权面；
--     admin 全权；客户端零写（无写策略 + 无写 grant，0002/0016 范式）
-- ------------------------------------------------------------
alter table public.asset_360_sequences enable row level security;
alter table public.asset_360_frames    enable row level security;

drop policy if exists "asset_360_sequences select ready or admin" on public.asset_360_sequences;
create policy "asset_360_sequences select ready or admin" on public.asset_360_sequences
  for select using (status = 'ready' or public.is_admin());

drop policy if exists "asset_360_sequences admin all" on public.asset_360_sequences;
create policy "asset_360_sequences admin all" on public.asset_360_sequences
  for insert with check (public.is_admin());

drop policy if exists "asset_360_sequences admin update" on public.asset_360_sequences;
create policy "asset_360_sequences admin update" on public.asset_360_sequences
  for update using (public.is_admin());

drop policy if exists "asset_360_sequences admin delete" on public.asset_360_sequences;
create policy "asset_360_sequences admin delete" on public.asset_360_sequences
  for delete using (public.is_admin());

drop policy if exists "asset_360_frames select via sequence" on public.asset_360_frames;
create policy "asset_360_frames select via sequence" on public.asset_360_frames
  for select using (
    exists (
      select 1 from public.asset_360_sequences s
      where s.id = asset_360_frames.sequence_id
        and (s.status = 'ready' or public.is_admin())
    )
  );

drop policy if exists "asset_360_frames admin insert" on public.asset_360_frames;
create policy "asset_360_frames admin insert" on public.asset_360_frames
  for insert with check (public.is_admin());

drop policy if exists "asset_360_frames admin update" on public.asset_360_frames;
create policy "asset_360_frames admin update" on public.asset_360_frames
  for update using (public.is_admin());

drop policy if exists "asset_360_frames admin delete" on public.asset_360_frames;
create policy "asset_360_frames admin delete" on public.asset_360_frames
  for delete using (public.is_admin());

-- ------------------------------------------------------------
-- (4) published_360 收敛视图（Gate §G6）
--     公开读面唯一入口：published asset ⋈ active ready sequence；
--     frames jsonb 按 frame_index 排序（一次查询供整个 Viewer）。
--     全新视图 → 无 0021 的"列只能末尾追加"约束。
-- ------------------------------------------------------------
create or replace view public.published_360
with (security_invoker = true) as
select
  a.id                                                   as asset_id,
  s.id                                                   as sequence_id,
  s.frame_count,
  jsonb_agg(
    jsonb_build_object('index', f.frame_index, 'path', f.source_path)
    order by f.frame_index
  )                                                      as frames
from public.assets a
join public.asset_360_sequences s
  on s.id = a.active_360_sequence_id and s.status = 'ready'
join public.asset_360_frames f
  on f.sequence_id = s.id
where a.status = 'published'
group by a.id, s.id, s.frame_count;

-- ------------------------------------------------------------
-- (5) audit allowlist 44 → 48（严格超集，DO 块 + 防窄化守卫，0013/0016/0018 先例）
--     新增: 360.sequence.created / 360.sequence.activated / 360.sequence.deleted
--           360.upload.failed
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
      'github.delete.retry','github.orphan.purged',
      'schedule.item_created','schedule.item_updated','schedule.item_deleted',
      'schedule.item_published','schedule.item_archived',
      'users.notes_updated'
    )
  ) then
    raise notice '0022 allowlist rebuild skipped: existing actions beyond the 44-item set';
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
      'schedule.item_published','schedule.item_archived',
      'users.notes_updated',
      '360.sequence.created','360.sequence.activated','360.sequence.deleted',
      '360.upload.failed'
    ));
end;
$$;

-- ------------------------------------------------------------
-- (6) grants（0002 范式：基表 select 显式授——RLS 过滤行；
--     写零 grant ⇒ 客户端零写，Worker service_role 走其既有全量授权通道）
-- ------------------------------------------------------------
grant select on public.asset_360_sequences to anon, authenticated, service_role;
grant select on public.asset_360_frames    to anon, authenticated, service_role;
