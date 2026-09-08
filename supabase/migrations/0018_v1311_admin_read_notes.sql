-- ============================================================
-- 0018: V1.3.1 跟进修复 + 管理员备注
-- 依据: Owner 2026-09-08 走查反馈（chat 裁决）:
--   F1 根因修复 — credit_accounts SELECT 策略缺 admin 分支（0012 §3 只写了
--      user_id = auth.uid()），admin 客户端读不到他人账户 → Users 页积分列
--      全 '—'、「调整积分」按钮灰色、Unlimited 开关无从操作。
--      写路径零变化（RLS 无写策略 + grants 仅 service_role，Worker 独占）。
--   F3 管理员备注 — 新表 user_admin_notes：RLS 仅 is_admin()（普通用户
--      连自己的备注都不可见，严格"仅管理员可见"）；写入落审计
--      users.notes_updated（allowlist 43 → 44，严格超集）。
-- 幂等: drop policy if exists / create or replace / create table if not exists /
--       allowlist DO 块防窄化守卫（0013/0014/0016 先例）。
-- 不变量: credits 写链路（Worker/RPC）、既有表 RLS、published 视图零改动。
-- ============================================================

-- ------------------------------------------------------------
-- (1) F1: credit_accounts SELECT 策略补 admin 分支（只读放宽）
--     写面不动：无 insert/update/delete 策略 + grants 已限 service_role。
-- ------------------------------------------------------------
drop policy if exists "credit_accounts select own" on public.credit_accounts;
create policy "credit_accounts select own or admin" on public.credit_accounts
  for select using (user_id = auth.uid() or public.is_admin());

-- ------------------------------------------------------------
-- (2) F3: user_admin_notes 表
-- ------------------------------------------------------------
create table if not exists public.user_admin_notes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  notes      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create trigger touch_user_admin_notes_upd
  before update on public.user_admin_notes
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- (3) RLS：仅活跃 admin（is_admin() 含 profiles.disabled=false）
-- ------------------------------------------------------------
alter table public.user_admin_notes enable row level security;

drop policy if exists "user_admin_notes admin all" on public.user_admin_notes;
create policy "user_admin_notes admin all" on public.user_admin_notes
  for all using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- (4) 审计触发器（write_audit 用 new.id 作 target，本表主键是 user_id，
--     故用专用函数；is_admin 门禁同 write_audit；upsert 语义下
--     INSERT 与 UPDATE 都记 users.notes_updated，DELETE 记同动作 op=DELETE）
-- ------------------------------------------------------------
create or replace function public.write_user_admin_notes_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_target text;
begin
  if not public.is_admin() then
    return null;
  end if;
  v_target := coalesce(new.user_id::text, old.user_id::text);
  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), 'users.notes_updated', TG_TABLE_NAME, v_target,
    jsonb_build_object('op', TG_OP, 'notes_len', length(coalesce(new.notes, old.notes, '')))
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_user_admin_notes_w on public.user_admin_notes;
create trigger audit_user_admin_notes_w
  after insert or update or delete on public.user_admin_notes
  for each row execute function public.write_user_admin_notes_audit();

-- ------------------------------------------------------------
-- (5) allowlist 43 → 44（严格超集，DO 块 + 防窄化守卫，同 0013/0016）
--     新增: users.notes_updated
-- ------------------------------------------------------------
do $$
begin
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
      'schedule.item_published','schedule.item_archived'
    )
  ) then
    raise notice '0018 allowlist rebuild skipped: existing actions beyond the 43-item set';
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
      'users.notes_updated'
    ));
end;
$$;

-- ------------------------------------------------------------
-- (6) grants：anon 零接触；authenticated 读写全靠 RLS 收敛到 admin；
--     service_role 全量（Worker 备用）。
-- ------------------------------------------------------------
revoke all on public.user_admin_notes from anon, authenticated;
grant  select, insert, update, delete on public.user_admin_notes to authenticated, service_role;
