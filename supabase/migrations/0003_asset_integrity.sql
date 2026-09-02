-- ============================================================
-- 0003: Asset Core 完整性守卫（Phase 3，Owner 批准的 Design Gate 产物）
--
-- 三件事：
--   1. 状态化审计：status 变更记录专用动作
--      draft/archived → published : asset.published
--      published      → draft     : asset.unpublished （Owner 批准扩展）
--      *              → archived  : asset.archived
--      archived       → draft     : asset.restored    （Owner 批准：archived 可恢复）
--      非 status 变更仍记 asset.updated（不再与状态审计重复记录）
--   2. Cover 同资产守卫：cover_image_id 必须属于本 Asset（跨语言允许）
--   3. Publish 服务端终守卫：进入 published 前必须已有
--      ≥1 个 published 语言且该语言 ≥1 张图（客户端校验之外的最后防线）
--
-- 无表结构变更；全部幂等。
-- ============================================================

-- ---------- 1a. 状态审计函数 ----------
create or replace function public.audit_asset_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text;
begin
  if not public.is_admin() then
    return null;
  end if;

  v_action := case
    when new.status = 'published' then 'asset.published'
    when new.status = 'archived'  then 'asset.archived'
    when new.status = 'draft' and old.status = 'published' then 'asset.unpublished'
    when new.status = 'draft' and old.status = 'archived'  then 'asset.restored'
    else null
  end;

  if v_action is null then
    return null;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), v_action, 'assets', new.id::text,
    jsonb_build_object('from', old.status, 'to', new.status)
  );
  return new;
end;
$$;

drop trigger if exists audit_asset_status on public.assets;
create trigger audit_asset_status
  after update of status on public.assets
  for each row
  when (old.status is distinct from new.status)
  execute function public.audit_asset_status_change();

-- ---------- 1b. 泛化 asset.updated 触发器：状态变更时跳过（避免双记） ----------
drop trigger if exists audit_assets_upd on public.assets;
create trigger audit_assets_upd
  after update on public.assets
  for each row
  when (old.status is not distinct from new.status)
  execute function public.write_audit('asset.updated');

-- ---------- 2. Cover 同资产守卫 ----------
create or replace function public.guard_asset_cover() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cover_image_id is not null then
    if not exists (
      select 1
      from public.images i
      join public.asset_languages l on l.id = i.asset_language_id
      where i.id = new.cover_image_id
        and l.asset_id = new.id
    ) then
      raise exception 'COVER_MISMATCH: cover_image_id % does not belong to asset %', new.cover_image_id, new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_assets_cover on public.assets;
create trigger guard_assets_cover
  before insert or update of cover_image_id on public.assets
  for each row
  execute function public.guard_asset_cover();

-- ---------- 3. Publish 服务端终守卫（INSERT 与 UPDATE 都拦） ----------
create or replace function public.guard_asset_publish() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published' then
    if not exists (
      select 1
      from public.asset_languages l
      where l.asset_id = new.id
        and l.status = 'published'
        and exists (select 1 from public.images i where i.asset_language_id = l.id)
    ) then
      raise exception 'PUBLISH_BLOCKED: asset % needs at least one published language with at least one image', new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_assets_publish on public.assets;
create trigger guard_assets_publish
  before insert or update of status on public.assets
  for each row
  execute function public.guard_asset_publish();
