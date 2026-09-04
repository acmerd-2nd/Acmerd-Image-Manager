-- ============================================================
-- 0011: V1.1 Phase A — site_settings（平台设置 KV）
-- 依据: docs/v1.1/01-design-gate.md (Rev B) §3.2 / §9
--
--   * 5 个初始 key（幂等种子），控件名按 Owner 裁决钉死:
--       Single Image Cost / ZIP Per-image Cost / Package Download Cost
--   * ZIP 语义钉死: ZIP 总价 = 所选图片数量 × zip_download_cost_per_image，
--     不是固定价（Gate §0.3）
--   * 读: anon + authenticated 可读（key 均非敏感；Gate §4）
--   * 写: 无任何客户端授权——仅 Worker service role 写，
--     settings.updated 审计由 Worker 直接落 audit_logs（allowlist 0013 扩）
--
-- 幂等: create if not exists / on conflict do nothing / DO 块防重。
-- ============================================================

create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

drop trigger if exists touch_site_settings_upd on public.site_settings;
create trigger touch_site_settings_upd
  before update on public.site_settings
  for each row execute function public.touch_updated_at();

-- ---------- 初始配置（幂等种子；不覆盖生产已调整值） ----------
insert into public.site_settings (key, value) values
  ('registration_enabled',          'true'::jsonb),
  ('schedule_navigation_enabled',   'false'::jsonb),
  ('single_image_download_cost',    '1'::jsonb),
  ('zip_download_cost_per_image',   '1'::jsonb),
  ('package_download_cost',         '15'::jsonb)
on conflict (key) do nothing;

-- ---------- grants（Gate §4: 整表可读，写零客户端） ----------
grant select on public.site_settings to anon, authenticated, service_role;
revoke insert, update, delete on public.site_settings from anon, authenticated;
grant  insert, update, delete on public.site_settings to service_role;

-- ============================================================
-- 0011 end. 幂等可重放。
-- ============================================================
