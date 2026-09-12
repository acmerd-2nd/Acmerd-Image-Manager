-- ===========================================================================
-- V1.9.0 P0-2：把封面图片的 provider/storage_path/source_path 并进 published_assets 视图，
--   使前端浏览页卡片无需再对每张卡各发一次 images 查询（消除封面 N+1）。
--   封面是「本资产 cover_image_id 指向的那张 ready 图」，视图里已通过
--   `left join images i (i.asset_language_id=l.id and i.status='ready')` 纳入，
--   故用 array_agg(...) filter (where i.id = a.cover_image_id))[1] 单值取出，不新增 join、不改分组。
--   视图列序：现有 9 列（0021）保持原位，三列 cover_* 追加到【末尾 collection_id 之后】。
--     —— CREATE OR REPLACE VIEW 只允许在末尾新增列，绝不能在中间插入/改名（否则报
--        "cannot change name of view column ..."）。客户端用 .select('*') 按列名取值，列序无关。
--   幂等：create or replace view + grant 兜底。
-- ===========================================================================

create or replace view public.published_assets
with (security_invoker = true) as
select
  a.id,
  a.name,
  a.slug,
  a.description,
  a.cover_image_id,
  count(distinct i.id)                                                          as image_count,
  count(distinct l.language_code) filter (where l.status = 'published')         as language_count,
  coalesce(json_agg(distinct t.name) filter (where t.name is not null), '[]')   as tags,
  a.collection_id,
  (array_agg(i.provider)     filter (where i.id = a.cover_image_id))[1]         as cover_provider,
  (array_agg(i.storage_path) filter (where i.id = a.cover_image_id))[1]         as cover_storage_path,
  (array_agg(i.source_path)  filter (where i.id = a.cover_image_id))[1]         as cover_source_path
from public.assets a
join public.asset_languages l
  on l.asset_id = a.id and l.status = 'published'
left join public.images i
  on i.asset_language_id = l.id and i.status = 'ready'
left join public.asset_tags at_ on at_.asset_id = a.id
left join public.tags t on t.id = at_.tag_id
where a.status = 'published'
group by a.id;

grant select on public.published_assets to anon, authenticated;

-- ------------------------------------------------------------
-- (2) 因 search_* 用 RETURNS TABLE 固定输出列，视图新列不会自动透传；
--     重建三函数，各追加 cover_provider/cover_storage_path/cover_source_path（取自视图）。
--     校验/排序/分页/total/授权 全部与 0008 保持一致（仅加列，不改语义）。
--     ⚠ Postgres 禁止用 CREATE OR REPLACE 修改【已存在函数的返回类型】（加列即改返回类型），
--       故必须先 DROP 再 CREATE。db-apply 以单隐式事务整文件执行 → drop+create 原子，无「函数缺失」窗口。
-- ------------------------------------------------------------
drop function if exists public._search_assets_core(text, text[]);
drop function if exists public.search_assets(text, text[]);
drop function if exists public.search_assets_paged(text, text[], int, int);

create or replace function public._search_assets_core(
  p_q text default null,
  p_tags text[] default null
) returns table (
  id             uuid,
  name           text,
  slug           text,
  description    text,
  cover_image_id uuid,
  image_count    bigint,
  language_count bigint,
  tags           jsonb,
  cover_provider      text,
  cover_storage_path  text,
  cover_source_path   text,
  updated_at     timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_q    text;
  v_esc  text;
  v_tags text[];
begin
  v_q := nullif(btrim(coalesce(p_q, '')), '');
  if v_q is not null and length(v_q) > 200 then
    raise exception 'QUERY_TOO_LONG';
  end if;

  if p_tags is not null then
    select array_agg(distinct t) into v_tags
    from unnest(p_tags) as t
    where t is not null and btrim(t) <> '';
  end if;

  if v_tags is not null then
    if cardinality(v_tags) > 10 then
      raise exception 'TOO_MANY_TAGS';
    end if;
    if exists (select 1 from unnest(v_tags) as t where length(t) > 64) then
      raise exception 'TAG_TOO_LONG';
    end if;
  end if;

  v_esc := replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select
    pa.id, pa.name, pa.slug, pa.description, pa.cover_image_id,
    pa.image_count, pa.language_count, pa.tags::jsonb,
    pa.cover_provider::text, pa.cover_storage_path, pa.cover_source_path,
    a.updated_at
  from public.published_assets pa
  join public.assets a on a.id = pa.id
  where
    (
      v_q is null
      or pa.name        ilike '%' || v_esc || '%'
      or pa.description ilike '%' || v_esc || '%'
      or exists (
        select 1
        from public.asset_tags at_
        join public.tags tg on tg.id = at_.tag_id
        where at_.asset_id = pa.id
          and tg.name ilike '%' || v_esc || '%'
      )
    )
    and (
      v_tags is null
      or cardinality(v_tags) = (
        select count(distinct tg2.slug)
        from public.asset_tags at2
        join public.tags tg2 on tg2.id = at2.tag_id
        where at2.asset_id = pa.id
          and tg2.slug = any (v_tags)
      )
    );
end;
$$;

create or replace function public.search_assets(
  p_q text default null,
  p_tags text[] default null
) returns table (
  id             uuid,
  name           text,
  slug           text,
  description    text,
  cover_image_id uuid,
  image_count    bigint,
  language_count bigint,
  tags           jsonb,
  cover_provider      text,
  cover_storage_path  text,
  cover_source_path   text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  return query
  select c.id, c.name, c.slug, c.description, c.cover_image_id,
         c.image_count, c.language_count, c.tags,
         c.cover_provider, c.cover_storage_path, c.cover_source_path
  from public._search_assets_core(p_q, p_tags) c
  order by c.updated_at desc, c.id asc;
end;
$$;

create or replace function public.search_assets_paged(
  p_q text default null,
  p_tags text[] default null,
  p_page int default 1,
  p_per_page int default 24
) returns table (
  id             uuid,
  name           text,
  slug           text,
  description    text,
  cover_image_id uuid,
  image_count    bigint,
  language_count bigint,
  tags           jsonb,
  cover_provider      text,
  cover_storage_path  text,
  cover_source_path   text,
  total          bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_page int;
  v_per  int;
begin
  v_per  := least(greatest(coalesce(p_per_page, 24), 1), 100);
  v_page := greatest(coalesce(p_page, 1), 1);

  return query
  select c.id, c.name, c.slug, c.description, c.cover_image_id,
         c.image_count, c.language_count, c.tags,
         c.cover_provider, c.cover_storage_path, c.cover_source_path,
         count(*) over ()::bigint as total
  from public._search_assets_core(p_q, p_tags) c
  order by c.updated_at desc, c.id asc
  limit v_per offset (v_page - 1) * v_per;
end;
$$;

revoke all on function public._search_assets_core(text, text[]) from public;
grant execute on function public._search_assets_core(text, text[]) to anon, authenticated;

revoke all on function public.search_assets(text, text[]) from public;
grant execute on function public.search_assets(text, text[]) to anon, authenticated;

revoke all on function public.search_assets_paged(text, text[], int, int) from public;
grant execute on function public.search_assets_paged(text, text[], int, int) to anon, authenticated;
