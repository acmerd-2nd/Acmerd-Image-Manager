-- ============================================================
-- 0002: 表权限授予（GRANT）
-- 直连 postgres（scripts/db-apply.mjs）建的表缺少 Supabase 对
-- anon / authenticated / service_role 的默认 GRANT，需显式授权。
-- 行级安全由 RLS（0001）负责；本文件只解决"角色能否尝试操作"。
--
-- 安全原则：
--   * user_roles / audit_logs：客户端角色（anon/authenticated）无任何写权限，
--     写入仅经 service role（Worker）或 security definer 触发器
--   * schema_migrations：不对客户端角色开放
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;

-- ---------- 读（anon + authenticated + service_role；行级由 RLS 过滤） ----------
grant select on public.profiles         to anon, authenticated, service_role;
grant select on public.user_roles       to anon, authenticated, service_role;
grant select on public.assets           to anon, authenticated, service_role;
grant select on public.asset_languages  to anon, authenticated, service_role;
grant select on public.images           to anon, authenticated, service_role;
grant select on public.tags             to anon, authenticated, service_role;
grant select on public.asset_tags       to anon, authenticated, service_role;
grant select on public.download_sources to anon, authenticated, service_role;
grant select on public.audit_logs       to anon, authenticated, service_role;

-- ---------- 业务表写权限（authenticated；RLS 限制实际只有 admin 能写成功） ----------
grant insert, update, delete on public.assets           to authenticated, service_role;
grant insert, update, delete on public.asset_languages  to authenticated, service_role;
grant insert, update, delete on public.images           to authenticated, service_role;
grant insert, update, delete on public.tags             to authenticated, service_role;
grant insert, update, delete on public.asset_tags       to authenticated, service_role;
grant insert, update, delete on public.download_sources to authenticated, service_role;

-- profiles：用户只能 UPDATE 自己的行（RLS + guard 触发器）
grant update on public.profiles to authenticated, service_role;

-- user_roles / audit_logs：仅 service_role 可写（Worker 改角色 / 补审计）
grant insert, update, delete on public.user_roles to service_role;
grant insert, update, delete on public.audit_logs to service_role;

-- 序列（audit_logs identity 由 service_role 插入时使用）
grant usage, select on all sequences in schema public to service_role;

-- ---------- 未来 migration 新建表的默认授权（均为 postgres 角色创建） ----------
alter default privileges for role postgres in schema public
  grant select on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;

-- migration 记录表不对客户端开放
revoke all on public.schema_migrations from anon, authenticated;
