-- 0015_collection_hierarchy.sql — V1.2 A 多层 Folder（Design Gate docs/v1.2/01，D1–D5 Owner 2026-09-07 批准）
--   D1: 任意深度 + 硬上限 5 层；同一触发器内防环 + 子树高度校验
--   D2: 子级公开可见性 = 全链 published（published_collections 视图递归链，security_invoker 下 RLS 自动生效）
--   D3: 删父 = RESTRICT（FK 显式 RESTRICT + Worker 预检 COLLECTION_HAS_CHILDREN），绝不级联/升根
--   D4: asset_count 只数直接子资产（视图保持原 inner-join 口径，零递归）
--   幂等：全部 IF NOT EXISTS / drop+create / create or replace
--   红线：URL /collection/:slug 语义不变；RLS 授权面零新增；audit allowlist 零改动

-- ---------- (1) parent_id 自引用 ----------
alter table public.collections
  add column if not exists parent_id uuid references public.collections (id) on delete restrict;

-- 自引用 CHECK（便宜的即时校验；跨节点环由触发器拦）
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'collections_parent_not_self' and conrelid = 'public.collections'::regclass
  ) then
    alter table public.collections
      add constraint collections_parent_not_self check (parent_id is null or parent_id <> id);
  end if;
end $$;

create index if not exists idx_collections_parent on public.collections (parent_id);

-- ---------- (2) 层级守卫：防环 + 深度上限 5 + 子树高度 ----------
-- 错误码（Worker 映射）：COLLECTION_PARENT_SELF / COLLECTION_CYCLE / COLLECTION_DEPTH_EXCEEDED
create or replace function public.guard_collection_hierarchy() returns trigger
language plpgsql as $$
declare
  v_cursor   uuid;
  v_depth    int := 0;   -- new 节点的祖先数（new 自身深度 = v_depth + 1）
  v_sub_h    int;        -- 子树最深后代相对 new 的层数（直接子 = 1）
begin
  -- 基础情形：置根
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'COLLECTION_PARENT_SELF';
  end if;

  -- 沿祖先链向上：防环 + 深度计步（new 深度 = v_depth + 1 ≤ 5 ⇒ v_depth ≤ 4）
  v_cursor := new.parent_id;
  loop
    v_depth := v_depth + 1;
    if v_depth > 4 then
      raise exception 'COLLECTION_DEPTH_EXCEEDED';
    end if;
    if v_cursor = new.id then
      raise exception 'COLLECTION_CYCLE';
    end if;
    select parent_id into v_cursor from public.collections where id = v_cursor;
    exit when v_cursor is null;
  end loop;

  -- 子树随迁（仅 UPDATE 换父且原有子级）：最深后代深度 = v_depth + 1 + v_sub_h ≤ 5
  if tg_op = 'UPDATE' then
    if new.parent_id is distinct from old.parent_id
       and exists (select 1 from public.collections where parent_id = old.id) then
      -- d = 后代相对 old（即随迁 new）的层数，直接子 = 1；最深后代总深度 = (v_depth+1) + max(d)
      select coalesce(max(d.d), 0) into v_sub_h
      from (
        with recursive sub as (
          select k.id, 1 as d from public.collections k where k.parent_id = old.id
          union all
          select k2.id, s.d + 1 from public.collections k2 join sub s on k2.parent_id = s.id
        )
        select d from sub
      ) d;
      if v_depth + 1 + v_sub_h > 5 then
        raise exception 'COLLECTION_DEPTH_EXCEEDED';
      end if;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists guard_collection_hierarchy on public.collections;
create trigger guard_collection_hierarchy
  before insert or update of parent_id on public.collections
  for each row execute function public.guard_collection_hierarchy();

-- ---------- (3) published_collections 视图重建：+parent_id + 全链可见性（D2/D4） ----------
-- security_invoker ⇒ CTE 内对 collections 的引用同样吃 RLS：
--   anon 只见 published 行 ⇒ 草稿祖先令链断裂 ⇒ 其后代全部出局（全链 published 才公开）
--   admin（is_admin）见全部行 ⇒ 链完整（Admin 视角不受影响）
-- asset_count 口径不变：直接子资产 published 计数（inner join，零递归）
create or replace view public.published_collections
with (security_invoker = true) as
with recursive chain as (
  select c.id, c.parent_id, c.id as origin
    from public.collections c
   where c.status = 'published'
  union all
  select p.id, p.parent_id, ch.origin
    from public.collections p
    join chain ch on ch.parent_id = p.id
),
roots as (
  select distinct origin from chain where parent_id is null
)
select c.id, c.name, c.slug, c.description, c.cover_image_id, c.sort_order,
       count(a.id) as asset_count, c.parent_id
from public.collections c
join roots r on r.origin = c.id
join public.assets a on a.collection_id = c.id and a.status = 'published'
group by c.id, c.name, c.slug, c.description, c.cover_image_id, c.sort_order, c.parent_id;

-- ---------- (4) 授权与审计零变更说明 ----------
-- collections RLS（0012）不含列级谓词，新增列天然受既有政策保护；
-- parent_id 变更审计由 Worker 在 PATCH 时落 collection.updated（fields 含 parentId，allowlist 已有）。
