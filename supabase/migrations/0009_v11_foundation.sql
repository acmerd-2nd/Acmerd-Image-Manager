-- ============================================================
-- 0009: V1.1 Phase A — Foundation
-- 依据: docs/v1.1/01-design-gate.md (Rev B, Owner APPROVED WITH
--       REQUIRED ADJUSTMENTS, 2026-09-04) §3 / §3.4 / §7
--
-- 内容:
--   1. collections 表（单层组织容器；V1.1 不做多级目录——Gate D5）
--   2. assets.collection_id 可空 FK（ON DELETE SET NULL：collection_id=null
--      完全合法，老数据不强迫归组——Gate §7/裁决第八点）
--   3. images 来源模型升级: + provider / + source_path
--      （裁决 D3: source_url 为衍生值不落库；storage_path 保留原语义，
--       存量行 provider='supabase_storage'，双 provider 并存）
--   4. profiles.account_origin（'registered' | 'seed'，Gate D10——
--      仅标记字段，不构成特殊权限类别）
--   5. H1 硬约束（Owner 裁决）:
--      guard_collection_cover      — cover 图必须属于本 Collection 内 Asset
--      guard_asset_collection_move — 被 cover 引用的 Asset 不得移出该 Collection
--
-- 不变量: 不改动任何既有 RLS 策略/视图/审计语义；
--         published_assets 双层可见性 SELECT 面零改动（新列不被引用）。
-- 幂等: create if not exists / add column if not exists / DO 块防重 /
--       drop trigger if exists。全部可重放。
-- ============================================================

-- ------------------------------------------------------------
-- (1) collections 表
-- ------------------------------------------------------------
create table if not exists public.collections (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  description    text,
  cover_image_id uuid,
  status         asset_status not null default 'draft',
  sort_order     integer not null default 0,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_collections_status_sort
  on public.collections (status, sort_order);

drop trigger if exists touch_collections_upd on public.collections;
create trigger touch_collections_upd
  before update on public.collections
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- (2) assets.collection_id（可空；删除 Collection → Asset 回归未归组）
-- ------------------------------------------------------------
alter table public.assets add column if not exists collection_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'assets_collection_fk' and conrelid = 'public.assets'::regclass
  ) then
    alter table public.assets
      add constraint assets_collection_fk
      foreign key (collection_id) references public.collections(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_assets_collection on public.assets (collection_id);

-- ------------------------------------------------------------
-- (3) images 来源模型升级（D3 方案 A：保留 storage_path，新增通用来源列）
--     provider 枚举留 text（非 PG enum）：未来 R2/S3/Cloudflare Images
--     仅增值 + makeImageUrl 分支，Image 模型不再动（Gate §3.3-1）。
--     source_url 有意不建（裁决：衍生值一律由 makeImageUrl 动态计算）。
-- ------------------------------------------------------------
alter table public.images add column if not exists provider text not null default 'supabase_storage';
alter table public.images add column if not exists source_path text;
-- storage_path 对 github 行必须为 null（CHECK 互斥），故 0001 的 NOT NULL 需解除。
-- drop not null 天然幂等（列已 nullable 时无操作）。
alter table public.images alter column storage_path drop not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'images_source_check' and conrelid = 'public.images'::regclass
  ) then
    alter table public.images
      add constraint images_source_check check (
        (provider = 'supabase_storage' and storage_path is not null and source_path is null)
        or
        (provider = 'github' and storage_path is null and source_path is not null)
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- (4) profiles.account_origin（D10：seed 用户唯一特殊字段）
-- ------------------------------------------------------------
alter table public.profiles add column if not exists account_origin text not null default 'registered';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_account_origin_check' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_origin_check
      check (account_origin in ('registered', 'seed'));
  end if;
end $$;

-- ------------------------------------------------------------
-- (5) H1 — Collection Cover 完整性约束（Owner 硬约束，0009 内落库）
--     5a. guard_collection_cover: cover_image_id 必须属于
--         collection_id = 本 Collection 的某个 Asset（经 language 归属），
--         沿用 0003 guard_asset_cover 同资产守卫思路。
--     5b. guard_asset_collection_move: Asset 被某 Collection 用作 cover 时
--         不得改判归属（移出/置空均拦），防止产生"跨 Collection cover"。
--         删除 Collection 本身不受 5b 影响（FK set null 属 DELETE 路径）；
--         删除 cover 图走 images FK on delete set null 自然失效，无孤儿。
-- ------------------------------------------------------------
create or replace function public.guard_collection_cover() returns trigger
language plpgsql as $$
begin
  if new.cover_image_id is not null then
    if not exists (
      select 1
      from public.images i
      join public.asset_languages l on l.id = i.asset_language_id
      join public.assets a on a.id = l.asset_id
      where i.id = new.cover_image_id
        and a.collection_id = new.id
    ) then
      raise exception 'COLLECTION_COVER_MISMATCH: cover_image_id % does not belong to any asset within collection %', new.cover_image_id, new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_collections_cover on public.collections;
create trigger guard_collections_cover
  before insert or update of cover_image_id on public.collections
  for each row
  execute function public.guard_collection_cover();

create or replace function public.guard_asset_collection_move() returns trigger
language plpgsql as $$
begin
  if new.collection_id is distinct from old.collection_id then
    if exists (
      select 1
      from public.collections c
      where c.id = old.collection_id
        and c.cover_image_id in (
          select i.id
          from public.images i
          join public.asset_languages l on l.id = i.asset_language_id
          where l.asset_id = new.id
        )
    ) then
      raise exception 'COLLECTION_COVER_IN_USE: asset % is the cover source of collection %, reassign the cover before moving it', new.id, old.collection_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_assets_collection_move on public.assets;
create trigger guard_assets_collection_move
  before update of collection_id on public.assets
  for each row
  execute function public.guard_asset_collection_move();

-- ============================================================
-- 0009 end. 幂等可重放；published_assets / 既有 RLS / 审计语义零改动。
-- ============================================================
