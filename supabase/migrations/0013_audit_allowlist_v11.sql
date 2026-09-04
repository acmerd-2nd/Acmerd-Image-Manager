-- ============================================================
-- 0013: V1.1 Phase A — audit_logs.action allowlist 扩展 24 → 34
-- 依据: docs/v1.1/01-design-gate.md (Rev B) §11.3 + Owner D11 ✅
--
-- 新增 10 项（严格超集，幂等 DO 块，先 drop 再重建同事务无窗口）:
--   collection.created / collection.updated / collection.deleted
--   collection.published / collection.archived        （0012 触发器）
--   credits.adjusted / credits.unlimited_changed      （Worker 直写）
--   user.provisioned / user.deleted                   （Worker 直写）
--   settings.updated                                  （Worker 直写）
--
-- 图片增删沿用既有 image.uploaded / image.deleted（GitHub provider 语义已覆盖）。
-- 生产存量 action 均在既有 24 项内，重建 CHECK 无越界风险。
-- 顺序约束: 必须先于任何写新审计动作的代码部署（Gate §13.1）。
-- ============================================================

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
      'asset_language.created','asset_language.updated','asset_language.deleted',
      'asset_language.published','asset_language.unpublished',
      'user.role_changed','user.disabled','user.enabled',
      'download_source.updated',
      'collection.created','collection.updated','collection.deleted',
      'collection.published','collection.archived',
      'credits.adjusted','credits.unlimited_changed',
      'user.provisioned','user.deleted',
      'settings.updated'
    ));
end;
$$;

-- ============================================================
-- 0013 end. 幂等可重放；24 项既有动作完整保留（严格超集）。
-- ============================================================
