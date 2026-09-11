-- ===========================================================================
-- V1.8.0：用户头像（上传 + Cropper 裁剪）
--   存储：经 Worker POST /api/me/avatar 传 GitHub 图仓库 avatars/{userId}/avatar.{ext}，
--         与站点 Logo / 合集封面同范式（零租约、ghPutFile 幂等替换）。
--   DB：profiles.avatar_url 列 0001 早已存在（text, nullable）——本迁移无需改表结构。
--   本迁移仅一件事：把 profile.updated 加入 audit_logs.action allowlist（48 → 49）。
--   Worker 在成功/清除头像时写 profile.updated 审计（target_type='profiles', target_id=userId）。
-- ===========================================================================

-- ------------------------------------------------------------
-- audit allowlist 48 → 49（严格超集，DO 块 + 防窄化守卫，0013/0016/0018/0022 先例）
--   新增: profile.updated
-- ------------------------------------------------------------
do $$
begin
  -- 幂等：已允许 profile.updated 则跳过
  if exists (
    select 1 from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'audit_logs'
      and c.conname = 'audit_logs_action_allowlist'
      and pg_get_constraintdef(c.oid) like '%profile.updated%'
  ) then
    raise notice '0025 allowlist rebuild skipped: profile.updated already allowed';
    return;
  end if;

  -- 防窄化守卫：现存审计行若用了目标集之外的 action，则不重建（避免误删历史合法值）
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
      'users.notes_updated',
      '360.sequence.created','360.sequence.activated','360.sequence.deleted',
      '360.upload.failed'
    )
  ) then
    raise notice '0025 allowlist rebuild skipped: existing actions beyond the 48-item set';
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
      '360.upload.failed',
      'profile.updated'
    ));
end;
$$;
