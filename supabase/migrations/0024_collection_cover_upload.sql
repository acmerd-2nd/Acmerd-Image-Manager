-- V1.7.0：合集封面支持「本地上传独立图片」
-- 范式对齐站点 Logo（0019）：图片字节进 GitHub 图仓库独立命名空间 collections/{id}/cover.{ext}，
-- DB 仅存一个路径字符串 cover_source_path（非 FK、不进 images 表），前台经 githubRawUrl 公开出图。
-- 与既有 cover_image_id（选合集内资产图）互斥、且优先展示。
--
-- 为何零触发器改动：guard_collection_cover（0009:120）只在「insert/update of cover_image_id」时校验
-- cover_image_id 归属本合集资产；本列是独立新列，写它不触发该守卫。
-- 幂等：add column if not exists + create or replace view。

begin;

alter table public.collections
  add column if not exists cover_source_path text;

comment on column public.collections.cover_source_path is
  'V1.7.0：合集本地上传封面的 GitHub 仓库路径（collections/{id}/cover.{ext}）；与 cover_image_id 互斥，非空时优先展示。';

-- 重建 published_collections：在既有列【末尾】追加 cover_source_path
-- （PG create-or-replace view 只允许在末尾新增列，故顺序严格保持 0015 原样，仅尾部 +1）。
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
       count(a.id) as asset_count, c.parent_id, c.cover_source_path
from public.collections c
join roots r on r.origin = c.id
join public.assets a on a.collection_id = c.id and a.status = 'published'
group by c.id, c.name, c.slug, c.description, c.cover_image_id, c.sort_order, c.parent_id, c.cover_source_path;

commit;
