-- 0028_image_categories.sql
-- V1.10 第一批：资产图片三分类（主副图 / A+ / 品牌故事）；A+ 再分桌面/移动两套。
--   * category：'main'（主副图，默认，兼容既有全部图片）| 'aplus' | 'brand'
--   * aplus_variant：仅 category='aplus' 时非空，'desktop'(1464×600) | 'mobile'(600×450)
--   * 排序改为「按 (语言, 分类[, A+变体]) 分组内独立 sort_order」，主副图重排不影响 A+/品牌故事。
-- 全部幂等（DO 捕获 duplicate_object / if not exists），db-apply 亦只跑一次。

-- ---------- 枚举 ----------
do $$ begin
  create type public.image_category as enum ('main', 'aplus', 'brand');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.aplus_variant as enum ('desktop', 'mobile');
exception when duplicate_object then null; end $$;

-- ---------- 列（既有行按默认回填为 'main'）----------
alter table public.images add column if not exists category       public.image_category not null default 'main';
alter table public.images add column if not exists aplus_variant  public.aplus_variant;

-- ---------- 约束：A+ 必带变体；非 A+ 变体必空 ----------
do $$ begin
  alter table public.images
    add constraint images_category_variant_check check (
      (category =  'aplus' and aplus_variant is not null)
      or
      (category <> 'aplus' and aplus_variant is null)
    );
exception when duplicate_object then null; end $$;

-- ---------- 索引：分组内排序 ----------
drop index if exists public.idx_images_lang;
create index if not exists idx_images_lang_cat
  on public.images (asset_language_id, category, aplus_variant, sort_order);
