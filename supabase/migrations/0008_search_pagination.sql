-- ============================================================
-- 0008: Search 分页扩展（Phase 6 Query Layer 演进，Phase 9 唯一 DB 变更面）
--
-- Owner 裁决 D2（2a + 护栏）落地：
--   _search_assets_core(p_q, p_tags)  ← 承载 0005 全部校验 + WHERE（逐字搬移，单一事实来源）
--   search_assets(p_q, p_tags)        ← 薄壳，委托 core，对外契约【零破坏】(I1a/I1b)
--   search_assets_paged(p_q,p_tags,p_page,p_per_page) ← 同调 core + count(*) over() total + LIMIT/OFFSET
--
-- 冻结不变量（不得触碰）：published_assets 视图 / RLS / is_admin() / audit / disabled 门禁。
--   本文件仅新增/替换三个 SECURITY INVOKER 函数，无任何表/策略/触发器/审计动作变更。
--
-- 护栏（Owner D1/D2）：
--   * 排序稳定：updated_at DESC, id ASC（id 唯一 → 完全确定）；分页与 total 同一筛选。
--   * 越界页不报错、空页正常返回；p_per_page 钳制 [1,100]，p_page ≥ 1。
--   * total 不改变筛选语义（仅 count over 全量结果，不新增 WHERE）。
--   * I1a：search_assets 签名/返回列/类型/NULL/Tag AND/wildcard 转义/排序 全部与 0005 一致。
--   * I1b：core 与旧实现结果 canonical JSON 完全一致（隔离库回归证明）。
-- 幂等：create or replace + drop-if-exists。
-- ============================================================

-- ------------------------------------------------------------
-- (1) core：校验 + WHERE（逐字来自 0005），额外暴露 updated_at 供稳定排序
--     SECURITY INVOKER：以调用者身份执行，RLS 双层可见性完全继承
-- ------------------------------------------------------------
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
  -- 归一化 + 有界校验（与 0005 逐字一致）
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

  -- ILIKE 通配符转义（\ % _ 视为字面量）
  v_esc := replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select
    pa.id, pa.name, pa.slug, pa.description, pa.cover_image_id,
    pa.image_count, pa.language_count, pa.tags::jsonb, a.updated_at
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

-- ------------------------------------------------------------
-- (2) search_assets 薄壳：对外契约与 0005 完全一致（8 列，同序）
-- ------------------------------------------------------------
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
  tags           jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  return query
  select c.id, c.name, c.slug, c.description, c.cover_image_id,
         c.image_count, c.language_count, c.tags
  from public._search_assets_core(p_q, p_tags) c
  order by c.updated_at desc, c.id asc;
end;
$$;

-- ------------------------------------------------------------
-- (3) search_assets_paged：分页 + total（同一 core 筛选，顺序与全量一致）
-- ------------------------------------------------------------
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
  -- 边界钳制：page ≥ 1；per_page ∈ [1,100]（越界页 → offset 超量 → 空结果，不报错）
  v_per  := least(greatest(coalesce(p_per_page, 24), 1), 100);
  v_page := greatest(coalesce(p_page, 1), 1);

  return query
  select c.id, c.name, c.slug, c.description, c.cover_image_id,
         c.image_count, c.language_count, c.tags,
         count(*) over ()::bigint as total
  from public._search_assets_core(p_q, p_tags) c
  order by c.updated_at desc, c.id asc
  limit v_per offset (v_page - 1) * v_per;
end;
$$;

-- ------------------------------------------------------------
-- 授权（SECURITY INVOKER：调用者身份执行，RLS 仍生效；core 需可被执行以支撑调用链）
-- ------------------------------------------------------------
revoke all on function public._search_assets_core(text, text[]) from public;
grant execute on function public._search_assets_core(text, text[]) to anon, authenticated;

revoke all on function public.search_assets(text, text[]) from public;
grant execute on function public.search_assets(text, text[]) to anon, authenticated;

revoke all on function public.search_assets_paged(text, text[], int, int) from public;
grant execute on function public.search_assets_paged(text, text[], int, int) to anon, authenticated;
