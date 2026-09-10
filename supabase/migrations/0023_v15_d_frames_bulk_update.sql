-- V1.5 Phase D：360 帧批量登记 RPC
-- 动因（生产实走发现，本地 workerd 不演算）：Cloudflare Workers 单次调用有子请求配额
--   （本账户实测 50），而传帧端点原先「每帧 1 次 GitHub blob POST + 1 次 PostgREST PATCH」，
--   24 帧/批 = 48+ 子请求，正好在批尾撞墙（报 "Too many subrequests by single Worker invocation"）。
-- 解法（双保险）：(1) 整批帧登记合并为 1 次 RPC；(2) FRAME_BATCH_MAX 24→20。合并后 20 帧/批
--   ≈ 20 blob + 1 RPC + ~8 租约/校验/序列状态 ≈ 29 子请求，留足配额余量。
-- 安全面：仅 service_role 可执行（Worker Secret 独占）；security definer 绕过 RLS 属有意为之，
--   但用谓词限定「只允许改写 draft/uploading/failed 序列的帧」，杜绝篡改线上 ready 序列。

begin;

create or replace function public.update_asset_360_frames(p_frames jsonb)
returns int
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.asset_360_frames f
       set blob_sha   = x.blob_sha,
           file_size  = x.file_size,
           status     = 'uploading',
           updated_at = now()
      from jsonb_to_recordset(p_frames) as x(id uuid, blob_sha text, file_size bigint)
     where f.id = x.id
       and exists (
         select 1 from public.asset_360_sequences s
          where s.id = f.sequence_id
            and s.status in ('draft','uploading','failed')
       )
       and x.blob_sha ~ '^[0-9a-f]{40}$'
    returning 1
  )
  select count(*)::int from upd;
$$;

revoke all on function public.update_asset_360_frames(jsonb) from public, anon, authenticated;
grant execute on function public.update_asset_360_frames(jsonb) to service_role;

comment on function public.update_asset_360_frames(jsonb) is
  'V1.5 D：整批帧登记合并为 1 次调用（规避 Worker 子请求配额）；仅 service_role；仅限非线上序列。';

commit;
