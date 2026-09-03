-- ============================================================
-- 0007: Security Hardening — 审计盲区收口 + DEF-1 修复（Phase 8）
--
-- 依据：docs/phase-8/01-design-gate.md（Owner 裁决版，2026-09-03 APPROVED）
--
-- 交付四件事：
--   1. GAP-A：asset_languages 增删改全量审计（Owner D2 = 2a）
--      asset_language.created      (INSERT)
--      asset_language.deleted      (DELETE)
--      asset_language.published    (status draft → published)
--      asset_language.unpublished  (status published → draft)
--      asset_language.updated      (status 未变 + 业务列实际变化)
--      —— published/unpublished 为前台可见性第二层开关，与普通 updated 语义分离
--   2. GAP-B：images UPDATE 审计（Owner D3 = 3a）
--      image.updated：仅在 filename/storage_path/mime_type/file_size/
--      width/height/sort_order 等业务列实际变化时记录（WHEN 限定）
--      —— 排除 touch 触发器自动改写 updated_at 造成的无意义审计刷屏
--   3. DEF-1 修复（pre-existing defect fix，非新增能力；Owner D4 = 4a）
--      tags 补 updated_at 列：恢复 0001 既有 touch_tags_upd / audit_tags_upd
--      触发器的可用性（此前任何 tags UPDATE 报 record "new" has no
--      field "updated_at"，导致 AdminTagsPage 改名不可用）。历史缺陷修复，
--      不视为 Phase 8 新增能力。
--   4. audit_logs.action allowlist 扩展：18 → 24 项
--      (+ image.updated + 5 × asset_language.*)
--
-- 语义不变量（Owner 强制验收项）：
--   * 全部为 AFTER 审计触发器（只读 NEW/OLD + 写 audit_logs，不改业务行）；
--   * 不修改 assets / asset_languages / images / tags 的 INSERT/UPDATE/DELETE
--     数据面，无 BEFORE 数据守卫、无 NEW/OLD 篡改；
--   * published_assets 双层可见性（a.status='published' AND l.status='published'）
--     的 SELECT 面零改动 → 公开数据集合不得因本迁移漂移
--     （隔离库快照对比 + 状态迁移语义用例证明，见 Gate §6.4 / §10#3）。
--   * 无现有表结构/策略改动（唯一 DDL：tags 加列 + 换 allowlist CHECK）。
--   * 全部幂等（create or replace / drop trigger if exists / DO 块防重 /
--     add column if not exists）。
-- ============================================================

-- ------------------------------------------------------------
-- (0) audit_logs.action allowlist 扩展 18 → 24
--     先 drop 旧 CHECK 再重建（同事务内无窗口）；
--     新枚举 = 既有 18 项严格超集，生产存量行无越界风险。
-- ------------------------------------------------------------
do $$
begin
  alter table public.audit_logs drop constraint if exists audit_logs_action_allowlist;
  alter table public.audit_logs
    add constraint audit_logs_action_allowlist
    check (action in (
      'asset.created','asset.updated','asset.deleted','asset.published','asset.unpublished',
      'asset.archived','asset.restored',
      'image.uploaded','image.updated','image.deleted',
      'tag.created','tag.updated','tag.deleted',
      'asset.tag_added','asset.tag_removed',
      'asset_language.created','asset_language.updated','asset_language.published',
      'asset_language.unpublished','asset_language.deleted',
      'download_source.updated',
      'user.role_changed','user.disabled','user.enabled'
    ));
end;
$$;

-- ------------------------------------------------------------
-- (1) GAP-A：asset_languages 审计
--     1a. INSERT / DELETE 经既有 write_audit()（is_admin 过滤，同 0001 资产模式）
--     1b. status 变更 → 专用函数区分 published / unpublished（参照 0003 assets 先例）
--     1c. status 未变且业务列（asset_id / language_code）实际变化 → updated
--         （纯 touch 只刷 updated_at → 跳过，防刷屏）
-- ------------------------------------------------------------

-- 1a. created / deleted
drop trigger if exists audit_asset_languages_ins on public.asset_languages;
create trigger audit_asset_languages_ins
  after insert on public.asset_languages
  for each row execute function public.write_audit('asset_language.created');

drop trigger if exists audit_asset_languages_del on public.asset_languages;
create trigger audit_asset_languages_del
  after delete on public.asset_languages
  for each row execute function public.write_audit('asset_language.deleted');

-- 1b. status 变更（draft↔published）→ published / unpublished
create or replace function public.audit_asset_language_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text;
begin
  if not public.is_admin() then
    return null;
  end if;

  -- language_status 仅 draft/published 两态，WHEN 已保证 status 确实变化
  v_action := case
    when new.status = 'published' then 'asset_language.published'
    when new.status = 'draft'     then 'asset_language.unpublished'
    else null
  end;

  if v_action is null then
    return null;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), v_action, 'asset_languages', new.id::text,
    jsonb_build_object('asset_id', new.asset_id, 'from', old.status, 'to', new.status)
  );
  return new;
end;
$$;

drop trigger if exists audit_asset_languages_status on public.asset_languages;
create trigger audit_asset_languages_status
  after update of status on public.asset_languages
  for each row
  when (old.status is distinct from new.status)
  execute function public.audit_asset_language_status();

-- 1c. status 未变 → updated（仅业务列实际变化时；纯 touch 跳过）
create or replace function public.audit_asset_language_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    return null;
  end if;

  -- asset_id / language_code / status 均未变（仅 touch 刷 updated_at）→ 不审计
  if new.asset_id is not distinct from old.asset_id
     and new.language_code is not distinct from old.language_code
     and new.status is not distinct from old.status
  then
    return null;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), 'asset_language.updated', 'asset_languages', new.id::text,
    jsonb_build_object(
      'asset_id_from', old.asset_id, 'asset_id_to', new.asset_id,
      'language_from', old.language_code, 'language_to', new.language_code
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_asset_languages_upd on public.asset_languages;
create trigger audit_asset_languages_upd
  after update on public.asset_languages
  for each row
  when (old.status is not distinct from new.status)
  execute function public.audit_asset_language_updated();

-- ------------------------------------------------------------
-- (2) GAP-B：images UPDATE 审计（Owner D3 = 3a）
--     WHEN 限定业务列实际变化；touch updated_at 的纯时间戳更新永不触发
-- ------------------------------------------------------------
create or replace function public.audit_image_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    return null;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), 'image.updated', 'images', new.id::text,
    jsonb_build_object(
      'filename_from',    old.filename,
      'filename_to',      new.filename,
      'sort_order_from',  old.sort_order,
      'sort_order_to',    new.sort_order
    )
  );
  return new;
end;
$$;

drop trigger if exists audit_images_upd on public.images;
create trigger audit_images_upd
  after update on public.images
  for each row
  when (
    new.filename      is distinct from old.filename
    or new.storage_path is distinct from old.storage_path
    or new.mime_type   is distinct from old.mime_type
    or new.file_size   is distinct from old.file_size
    or new.width       is distinct from old.width
    or new.height      is distinct from old.height
    or new.sort_order  is distinct from old.sort_order
  )
  execute function public.audit_image_updated();

-- ------------------------------------------------------------
-- (3) DEF-1 修复（pre-existing defect fix，0001 引入）
--     tags 补 updated_at 列，恢复 touch_tags_upd / audit_tags_upd 可用性
--     回填 created_at：保留既有行的创建时序，避免一次性全部刷成 now()
-- ------------------------------------------------------------
alter table public.tags add column if not exists updated_at timestamptz;

update public.tags
   set updated_at = created_at
 where updated_at is null;

alter table public.tags alter column updated_at set not null;
alter table public.tags alter column updated_at set default now();

-- ============================================================
-- 0007 end. 幂等可重放；无 Phase 2–7 逻辑/策略改动。
-- ============================================================
