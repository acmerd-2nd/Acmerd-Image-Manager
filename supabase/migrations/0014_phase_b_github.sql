-- ============================================================
-- 0014: V1.1 Phase B (PB-1) — GitHub Image Repository 地基
-- 依据: docs/v1.1/04-phase-b-design-gate.md（APPROVED WITH REQUIRED
--       ADJUSTMENTS，Owner 2026-09-04 裁决）§2/§3/§9/§10/§12
--
-- 内容:
--   1. github_write_leases 租约表（跨 Worker isolate 写入串行，PB-1 §2）
--      + claim/release SECURITY DEFINER RPC（仅 service_role 可执行）
--   2. images.status 四态（Owner 裁决 Q3）:
--      uploading | ready | failed | deleting —— 公开可见性只出 ready
--      存量行一次性默认 ready（语义不变，零漂移）
--   3. images.source_sha: github 行的预期 git blob sha（上传成功判定
--      response.content.sha === source_sha，Owner 附加要求；sweeper 对账依据）
--   4. 公开可见性收敛: images select 策略 + published_assets 视图
--      只计/只出 ready 行（全 ready 数据下逐字节零漂移）
--   5. audit allowlist 34 → 38 幂等超集（0013 范式）:
--      github.upload.failed / github.upload.recovered
--      github.delete.retry / github.orphan.purged
--
-- 不变量: 0001–0013 既有策略/视图除本文件声明的可见性收敛外零改动；
--         全存量行 status='ready' → Guest 视角公开数据集合零漂移
--         （隔离库冒烟快照对比证明）。
-- 顺序约束: 必须先于 Worker GitHub 端点部署（同 Phase 8 先例）。
-- ============================================================

-- ------------------------------------------------------------
-- (1) github_write_leases（PB-1 §2：租约表，单语句原子抢占）
--     * 仅 service_role 有表权限（无 grant → anon/authenticated 拒绝）
--     * claim 语义见 claim_github_lease；TTL=异常恢复窗口（Owner Q2 裁决）
-- ------------------------------------------------------------
create table if not exists public.github_write_leases (
  resource_key text primary key,          -- 'al:{asset_language_id}'
  owner_id     text not null,             -- Worker 请求 id（uuid）
  expires_at   timestamptz not null default now() + interval '120 seconds'
);

revoke all on public.github_write_leases from anon, authenticated;
grant select, insert, update, delete on public.github_write_leases to service_role;

-- 抢占租约（原子）:
--   * key 不存在 → INSERT 成功 → true
--   * key 存在且未过期 → 无行 → false（LEASE_BUSY；每个 Worker 请求使用新
--     owner id，无同 owner 重入语义）
--   * key 存在且已过期 → 覆盖 owner/expires → true（异常恢复）
--   coalesce 兜底：insert..returning 0 行时显式返回 false（PostgREST JSON 恒布尔）
create or replace function public.claim_github_lease(
  p_resource_key text,
  p_owner        text,
  p_ttl_seconds  int default 120
) returns boolean
language sql security definer set search_path = public as $$
  with ins as (
    insert into public.github_write_leases as l (resource_key, owner_id, expires_at)
    values (p_resource_key, p_owner, now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
    on conflict (resource_key) do update
      set owner_id   = excluded.owner_id,
          expires_at = excluded.expires_at
      where l.expires_at < now()
    returning owner_id
  )
  select coalesce((select owner_id = p_owner from ins), false);
$$;

-- 释放租约（仅持有者可释放；不匹配时 0 行删除，无副作用）
create or replace function public.release_github_lease(
  p_resource_key text,
  p_owner        text
) returns void
language sql security definer set search_path = public as $$
  delete from public.github_write_leases
  where resource_key = p_resource_key and owner_id = p_owner;
$$;

revoke all on function public.claim_github_lease(text, text, int) from public, anon, authenticated;
revoke all on function public.release_github_lease(text, text) from public, anon, authenticated;
grant execute on function public.claim_github_lease(text, text, int) to service_role;
grant execute on function public.release_github_lease(text, text) to service_role;

-- ------------------------------------------------------------
-- (2) images.status 四态 + source_sha（PB-1 §3，Owner Q3 裁决）
-- ------------------------------------------------------------
alter table public.images add column if not exists status text not null default 'ready';
alter table public.images add column if not exists source_sha text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'images_status_check' and conrelid = 'public.images'::regclass
  ) then
    alter table public.images
      add constraint images_status_check
      check (status in ('uploading', 'ready', 'failed', 'deleting'));
  end if;
end $$;

-- 存量行显式收敛（default 已保证新旧行 ready；此句幂等且无操作成本）
update public.images set status = 'ready' where status is distinct from 'ready' and status not in ('uploading', 'failed', 'deleting');

-- GitHub 行辅助索引：sweeper 扫描 + provider 维度查询
create index if not exists idx_images_status on public.images (status) where status <> 'ready';
create index if not exists idx_images_provider on public.images (provider);

-- ------------------------------------------------------------
-- (3) 公开可见性收敛（只出 ready；全 ready 数据零漂移）
-- ------------------------------------------------------------
-- 3a. images select 策略重建（非 admin 一律要求 status='ready'）
drop policy if exists "images select published or admin" on public.images;
create policy "images select published or admin" on public.images
  for select using (
    public.is_admin()
    or (
      status = 'ready'
      and exists (
        select 1
        from public.asset_languages l
        join public.assets a on a.id = l.asset_id
        where l.id = asset_language_id
          and l.status = 'published'
          and a.status = 'published'
      )
    )
  );

-- 3b. published_assets 视图重建：image_count 只计 ready（join 条件收敛）
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

-- 视图 grant 继承既有（0001）；create or replace 不重置 grant，此句幂等兜底
grant select on public.published_assets to anon, authenticated;

-- ------------------------------------------------------------
-- (4) audit allowlist 34 → 38（幂等超集 DO 块，0013 范式 + 防窄化守卫）
--     github.upload.failed    — 上传失败终态（PUT 穷尽/路径冲突）
--     github.upload.recovered — sweeper 将 uploading 收敛为 ready
--     github.delete.retry     — sweeper 重试 deleting 行的远端删除
--     github.orphan.purged    — sweeper 补偿删除 DB 无 ready 记录的远端对象
--     守卫：存量行存在 38 项之外动作时跳过重建（未来更宽迁移重放保护，
--     与 0013 同款守卫配合——任何窄化重建在含更宽动作数据时都是 unsafe）
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
      'github.delete.retry','github.orphan.purged'
    )
  ) then
    raise notice '0014 allowlist rebuild skipped: existing actions beyond the 38-item set';
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
      'github.delete.retry','github.orphan.purged'
    ));
end;
$$;

-- ============================================================
-- 0014 end. 幂等可重放；0001–0013 既有面除声明的可见性收敛外零改动。
-- ============================================================
