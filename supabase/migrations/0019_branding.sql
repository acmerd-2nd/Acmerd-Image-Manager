-- ============================================================
-- 0019: V1.4 站点品牌可配置（零 schema 变更；仅幂等种子 3 个 site_settings key）
-- 依据: docs/v1.4/01-design-gate.md（Owner 裁决）
--
--   * site_settings 为 KV 表（0011 已建），加 key 零 schema 迁移；
--     只种子 insert on conflict do nothing（不覆盖生产已调整值）。
--   * 读: 沿用 0011 anon + authenticated 可读（无需新 grant）。
--   * 写: 仅 Worker service_role（0011 grants 已覆盖）；审计复用 settings.updated
--     （allowlist 44 已含，无需扩）。
--   * URL 出口统一走 src/lib/image-source.ts（前端）、worker github.ts（服务端），
--     不新增独立出口。
--
-- 幂等: on conflict do nothing / DO 块防重。
-- ============================================================

-- ---------- 品牌设置（幂等种子；不覆盖生产已调整值） ----------
insert into public.site_settings (key, value) values
  ('brand_text',       '"ACMERD · 探知"'::jsonb),
  ('brand_title',      '"ACMERD · 探知"'::jsonb),
  ('brand_logo_path',  '""'::jsonb)
on conflict (key) do nothing;

-- ============================================================
-- 0019 end. 幂等可重放。
-- ============================================================
