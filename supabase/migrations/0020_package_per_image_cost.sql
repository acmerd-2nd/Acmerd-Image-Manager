-- ============================================================
-- 0020: V1.4.1 — Package 计价由固定一口价 → 按图片数动态（每图成本）
-- 依据: docs/v1.4.1/01-design-gate.md（Owner 2026-09-08 D1–D4 全批）
--
--   * 新增 key: package_download_cost_per_image（默认 0.5）
--     Package 总价 = published_image_count × package_download_cost_per_image
--     计数口径（D4）: 整个 Asset 跨所有已发布语言的 ready 图数
--     （= published_assets.image_count 视图口径，与前台展示一致）
--   * 旧键 package_download_cost（固定 15）: 保留不删（D1 回滚兼容——
--     wrangler rollback 回退旧 Worker 时仍读取该键）；V1.4.1+ 代码零读写。
--   * site_settings 为 jsonb KV：无 DDL / RLS / RPC 变更（0010 deduct_credits
--     p_amount numeric 原生支持小数，无需改）。
--   * 幂等: on conflict do nothing / delete 不存在行为无害。可重放。
-- ============================================================

insert into public.site_settings (key, value) values
  ('package_download_cost_per_image', '0.5'::jsonb)
on conflict (key) do nothing;

-- ============================================================
-- 0020 end. 幂等可重放；无表结构/策略/函数改动。
-- ============================================================
