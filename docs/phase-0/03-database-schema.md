# 03 · Database Schema（初始 Migration 草案）

> 落地为 `supabase/migrations/0001_initial_schema.sql`，Phase 1 前由 Owner 确认后执行。
> 所有表启用 RLS；策略详见 `05-rls-plan.md`。

## 枚举与辅助函数

```sql
-- 枚举
create type app_role        as enum ('user', 'admin');
create type asset_status    as enum ('draft', 'published', 'archived');
create type language_status as enum ('draft', 'published');
create type download_provider as enum ('quark', 'baidu');  -- 未来可扩展，alter type 即可

-- 角色判断（供 RLS / API 使用，杜绝前端判邮箱）
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = 'admin'
  );
$$;
```

## profiles / user_roles

```sql
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       app_role not null default 'user',
  created_at timestamptz not null default now()
);

-- 新用户自动建 profile + 默认 user 角色
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  insert into public.user_roles (user_id, role) values (new.id, 'user');
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at 自动维护（profiles/assets/asset_languages/images/tags/download_sources 统一挂此触发器）
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
```

## 资产域

```sql
create table public.assets (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  description    text,
  cover_image_id uuid,                     -- FK 在 images 建表后补加
  status         asset_status not null default 'draft',
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_assets_status on public.assets (status);
create index idx_assets_created on public.assets (created_at desc);

create table public.asset_languages (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  language_code text not null check (language_code in ('en','de','it','fr','es')),
  status        language_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (asset_id, language_code)         -- 一个 Asset 一种语言只有一个版本
);

create table public.images (
  id               uuid primary key default gen_random_uuid(),
  asset_language_id uuid not null references public.asset_languages(id) on delete cascade,
  filename         text not null,
  storage_path     text not null,          -- images/{asset_id}/{lang}/{filename}
  mime_type        text,
  file_size        bigint,
  width            integer,
  height           integer,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index idx_images_lang on public.images (asset_language_id, sort_order);

-- Asset ↔ Image 封面环回引用
alter table public.assets
  add constraint fk_assets_cover foreign key (cover_image_id)
  references public.images(id) on delete set null;
```

## 标签域

```sql
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table public.asset_tags (
  asset_id uuid not null references public.assets(id) on delete cascade,
  tag_id   uuid not null references public.tags(id)   on delete cascade,
  primary key (asset_id, tag_id)
);
create index idx_asset_tags_tag on public.asset_tags (tag_id);
```

## 下载源 / 审计

```sql
create table public.download_sources (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  provider   download_provider not null,
  url        text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, provider)
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,        -- asset.created / image.uploaded / user.role_changed ...
  target_type text not null,        -- asset / image / tag / download_source / user
  target_id   text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_created on public.audit_logs (created_at desc);

-- 首个管理员：Owner 手动指定邮箱，migration 一次性注入（避免硬编码在代码里）
-- create or replace function public.assign_first_admin(p_email text) ...
```

## 审计触发器（Admin 直连 Supabase 的写操作自动留痕）

```sql
create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text := TG_ARGV[0];
  v_target text;
begin
  if not public.is_admin() then return null; end if;  -- 仅审计 admin 行为
  v_target := coalesce(new.id::text, old.id::text);
  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), v_action, TG_TABLE_NAME, v_target,
          jsonb_build_object('op', TG_OP));
  return coalesce(new, old);
end; $$;

-- 示例挂载：
-- create trigger audit_asset_ins after insert on assets
--   for each row execute function public.write_audit('asset.created');
-- create trigger audit_asset_upd after update on assets
--   for each row execute function public.write_audit('asset.updated');
-- create trigger audit_asset_del after delete on assets
--   for each row execute function public.write_audit('asset.deleted');
-- images / tags / download_sources 同理
```

## 视图（供前台一次拉取 Asset Card 所需聚合）

```sql
create or replace view public.published_assets as
select
  a.id, a.name, a.slug, a.description, a.cover_image_id,
  count(distinct i.id)                                        as image_count,
  count(distinct l.language_code) filter (where l.status='published') as language_count,
  coalesce(json_agg(distinct t.name) filter (where t.name is not null), '[]') as tags
from assets a
join asset_languages l on l.asset_id = a.id and l.status = 'published'
left join images i on i.asset_language_id = l.id
left join asset_tags at on at.asset_id = a.id
left join tags t on t.id = at.tag_id
where a.status = 'published'
group by a.id;
```

## Slug 生成约定

- Asset/Tag 的 `slug`：`lower(name)` → 去除非 `a-z0-9` 字符 → 空格转 `-`，由前端/Worker 生成后随记录写入；冲突时追加 `-2`、`-3`。

## 数据库变更规则（重申总纲）

任何结构修改必须新增 migration 文件，禁止直接在 Dashboard 改生产结构。
