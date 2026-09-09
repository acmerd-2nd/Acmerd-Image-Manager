-- ============================================================
-- 0021: 资产详情页面包屑 — published_assets 增列 collection_id
-- 依据: Owner 指示（2026-09-09）「合集已有面包屑导航，资产没有快捷返回上层」。
-- 资产页需知道所属合集以构建「探索 / 合集链… / 资产名」面包屑。
-- （编号 0019 已被 branding、0020 被 package 计价占用）
--
-- 设计: create or replace 仅**增列** a.collection_id —— where 谓词、join、
--       grants、security_invoker 全部原样，公开可见性语义零漂移（NO-DRIFT）。
--       链上各级合集是否可见由 anon 读 published_collections（0012/0015 RLS，
--       全链 published 才公开）自然收敛：资产公开但其某级合集未发布时，
--       前端按链断裂处理（getPublishedBreadcrumbById 返回空数组 = 不渲染）。
-- 幂等: create or replace + grant 幂等兜底。
-- ============================================================

create or replace view public.published_assets
with (security_invoker = true) as
select
  a.id,
  a.name,
  a.slug,
  a.description,
  a.cover_image_id,
  a.collection_id,
  count(distinct i.id)                                                          as image_count,
  count(distinct l.language_code) filter (where l.status = 'published')         as language_count,
  coalesce(json_agg(distinct t.name) filter (where t.name is not null), '[]')   as tags
from public.assets a
join public.asset_languages l
  on l.asset_id = a.id and l.status = 'published'
left join public.images i
  on i.asset_language_id = l.id and i.status = 'ready'
left join public.asset_tags at_ on at_.asset_id = a.id
left join public.tags t on t.id = at_.tag_id
where a.status = 'published'
group by a.id;

-- 视图 grant 继承既有（0001）；幂等兜底（同 0014 注记）
grant select on public.published_assets to anon, authenticated;
