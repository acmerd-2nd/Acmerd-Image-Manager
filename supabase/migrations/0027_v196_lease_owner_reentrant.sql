-- 0027_v196_lease_owner_reentrant.sql
-- 根因修复：GitHub 写入租约改为「同 owner 可重入续租」。
--
-- 背景：/frames 每帧请求会 claim 一条序列级写入租约（claim_github_lease，TTL 90s）。
-- 原语义「不可按 owner 重入」：只要租约未过期，即使来的是【同一个管理员】也一律返回 false。
-- 当某一帧让 Worker 调用被资源限制杀掉 / 抛未捕获错误（表现为 503）时，处理函数里的
-- `finally { releaseLease }` 来不及执行 → 租约【泄漏】→ 同一管理员后续每一帧 claim 都被拒
-- → 成片 lease_busy(409)（Owner 实测：一帧 503 后，剩余帧全部 409，「漏了不少」）。
--
-- 修复：命中「未过期但 owner_id 就是自己」时，视为自己的续租 → 刷新 expires_at 并返回 true。
--   - 跨 owner（另一位管理员 / 另一条序列）仍严格互斥，保护不变；
--   - /frames 写入是内容寻址 blob + 按 frame_index 定位的行 + 幂等 bulk upsert，
--     同一 owner 的续租/并发不会破坏正确性；
--   - 泄漏租约被自己的下一次请求透明接管，消除级联失败。

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
      where l.expires_at < now() or l.owner_id = p_owner
    returning owner_id
  )
  select coalesce((select owner_id = p_owner from ins), false);
$$;

-- 幂等重申权限（CREATE OR REPLACE 已保留原授权，这里兜底确保 service_role 可执行、外部不可见）
revoke all on function public.claim_github_lease(text, text, int) from public, anon, authenticated;
grant execute on function public.claim_github_lease(text, text, int) to service_role;
