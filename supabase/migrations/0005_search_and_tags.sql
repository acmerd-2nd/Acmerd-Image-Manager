-- ============================================================
-- 0005: Search & Tags Query Layer（Phase 6，Owner 批准 Design Gate + 5 决策）
--
-- 决策落地：
--   D1 search_assets RPC，SECURITY INVOKER（走 published_assets，继承双层可见性，绝不 service role）
--   D2 ILIKE 子串匹配（无全文/相关性/模糊/同义词）
--   D3 多标签 AND 语义
--   D4 slug 仅在 INSERT 自动生成；改名不自动改 slug（保持稳定）
--   D5 asset_tags 增删审计：asset.tag_added / asset.tag_removed
--
-- 约束落地：
--   * 结果恒为 Asset 级（源自 published_assets 视图），绝不返回 Image
--   * 确定性排序：updated_at DESC, id ASC（无相关性排序）
--   * 有界输入校验：query ≤200 字符；tags ≤10 个；单 tag ≤64 字符
--   * 无表结构变更；幂等
-- ============================================================

-- ------------------------------------------------------------
-- (1) tags.slug 自动生成触发器 —— 仅 INSERT，不改名同步（D4）
-- ------------------------------------------------------------
create or replace function public.generate_tag_slug() returns trigger
language plpgsql as $$
declare
  base text;
  cand text;
  n int;
begin
  if new.slug is not null and btrim(new.slug) <> '' then
    return new; -- 显式提供则尊重之
  end if;

  base := lower(btrim(new.name));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  if base = '' then
    base := 'tag-' || substr(md5(new.name), 1, 8);
  end if;

  cand := base;
  n := 1;
  while exists (select 1 from public.tags where slug = cand and id <> new.id) loop
    n := n + 1;
    cand := base || '-' || n;
  end loop;

  new.slug := cand;
  return new;
end;
$$;

drop trigger if exists trg_generate_tag_slug on public.tags;
create trigger trg_generate_tag_slug
  before insert on public.tags
  for each row
  execute function public.generate_tag_slug();

-- ------------------------------------------------------------
-- (2) asset_tags 关系变更审计（D5）
--     仅 admin 可写 asset_tags（RLS），触发器 security definer 落审计
-- ------------------------------------------------------------
create or replace function public.audit_asset_tag() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text := TG_ARGV[0];
  v_asset  uuid := coalesce(new.asset_id, old.asset_id);
  v_tag    uuid := coalesce(new.tag_id, old.tag_id);
begin
  if not public.is_admin() then
    return coalesce(new, old);
  end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), v_action, 'assets', v_asset::text, jsonb_build_object('tag_id', v_tag));
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_asset_tags_ins on public.asset_tags;
create trigger audit_asset_tags_ins
  after insert on public.asset_tags
  for each row execute function public.audit_asset_tag('asset.tag_added');

drop trigger if exists audit_asset_tags_del on public.asset_tags;
create trigger audit_asset_tags_del
  after delete on public.asset_tags
  for each row execute function public.audit_asset_tag('asset.tag_removed');

-- ------------------------------------------------------------
-- (3) search_assets RPC —— SECURITY INVOKER，Asset 级结果（D1/D2/D3）
--
-- 返回契约（稳定，前端据此建模，等同 published_assets 视图形状）：
--   id             uuid
--   name           text
--   slug           text
--   description    text
--   cover_image_id uuid
--   image_count    bigint
--   language_count bigint
--   tags           jsonb   -- 字符串数组（标签名）
-- 排序：updated_at DESC, id ASC
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
declare
  v_q    text;
  v_esc  text;
  v_tags text[];
begin
  -- 归一化 + 有界校验
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
    pa.image_count, pa.language_count, pa.tags::jsonb
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
    )
  order by a.updated_at desc, pa.id asc;
end;
$$;

-- 调用授权（SECURITY INVOKER：以调用者身份执行，RLS 仍生效）
revoke all on function public.search_assets(text, text[]) from public;
grant execute on function public.search_assets(text, text[]) to anon, authenticated;
