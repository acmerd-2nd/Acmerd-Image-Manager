-- ============================================================
-- ACMERD Image Manager — 0001 Initial Schema
-- Phase 1 (设计依据: docs/phase-0/02-erd.md, 03-database-schema.md,
--          05-rls-plan.md, 06-storage-policy-plan.md)
-- ============================================================

-- ---------- 枚举 ----------
create type app_role          as enum ('user', 'admin');
create type asset_status      as enum ('draft', 'published', 'archived');
create type language_status   as enum ('draft', 'published');
create type download_provider as enum ('quark', 'baidu');

-- ---------- profiles / user_roles ----------
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

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  insert into public.user_roles (user_id, role) values (new.id, 'user');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 禁止用户自行修改 disabled（仅 admin / service role）
create or replace function public.guard_profile_disabled() returns trigger
language plpgsql as $$
begin
  if new.disabled is distinct from old.disabled and not public.is_admin() then
    raise exception 'changing disabled requires admin';
  end if;
  return new;
end;
$$;

create trigger guard_profile_disabled_upd
  before update on public.profiles
  for each row execute function public.guard_profile_disabled();

-- ---------- 辅助函数（依赖上面的表，需在建表后创建） ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = 'admin'
  );
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- 资产域 ----------
create table public.assets (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  description    text,
  cover_image_id uuid,
  status         asset_status not null default 'draft',
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_assets_status  on public.assets (status);
create index idx_assets_created on public.assets (created_at desc);

create table public.asset_languages (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  language_code text not null check (language_code in ('en','de','it','fr','es')),
  status        language_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (asset_id, language_code)
);

create table public.images (
  id                uuid primary key default gen_random_uuid(),
  asset_language_id uuid not null references public.asset_languages(id) on delete cascade,
  filename          text not null,
  storage_path      text not null,
  mime_type         text,
  file_size         bigint,
  width             integer,
  height            integer,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_images_lang on public.images (asset_language_id, sort_order);

alter table public.assets
  add constraint fk_assets_cover foreign key (cover_image_id)
  references public.images(id) on delete set null;

-- ---------- 标签域 ----------
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

-- ---------- 下载源 / 审计 ----------
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
  action      text not null,
  target_type text not null,
  target_id   text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_created on public.audit_logs (created_at desc);

-- ---------- updated_at 触发器 ----------
create trigger touch_profiles_upd         before update on public.profiles         for each row execute function public.touch_updated_at();
create trigger touch_assets_upd           before update on public.assets           for each row execute function public.touch_updated_at();
create trigger touch_asset_languages_upd  before update on public.asset_languages  for each row execute function public.touch_updated_at();
create trigger touch_images_upd           before update on public.images           for each row execute function public.touch_updated_at();
create trigger touch_tags_upd             before update on public.tags             for each row execute function public.touch_updated_at();
create trigger touch_download_sources_upd before update on public.download_sources for each row execute function public.touch_updated_at();

-- ---------- 审计触发器 ----------
create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text := TG_ARGV[0];
  v_target text;
begin
  if not public.is_admin() then
    return null;
  end if;
  v_target := coalesce(new.id::text, old.id::text);
  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    auth.uid(), v_action, TG_TABLE_NAME, v_target,
    jsonb_build_object('op', TG_OP)
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_assets_ins        after insert on public.assets           for each row execute function public.write_audit('asset.created');
create trigger audit_assets_upd        after update on public.assets           for each row execute function public.write_audit('asset.updated');
create trigger audit_assets_del        after delete on public.assets           for each row execute function public.write_audit('asset.deleted');
create trigger audit_images_ins        after insert on public.images           for each row execute function public.write_audit('image.uploaded');
create trigger audit_images_del        after delete on public.images           for each row execute function public.write_audit('image.deleted');
create trigger audit_tags_ins          after insert on public.tags             for each row execute function public.write_audit('tag.created');
create trigger audit_tags_upd          after update on public.tags             for each row execute function public.write_audit('tag.updated');
create trigger audit_tags_del          after delete on public.tags             for each row execute function public.write_audit('tag.deleted');
create trigger audit_download_src_ins  after insert on public.download_sources for each row execute function public.write_audit('download_source.updated');
create trigger audit_download_src_upd  after update on public.download_sources for each row execute function public.write_audit('download_source.updated');
create trigger audit_download_src_del  after delete on public.download_sources for each row execute function public.write_audit('download_source.updated');

-- ---------- published_assets 视图 ----------
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
left join public.images i on i.asset_language_id = l.id
left join public.asset_tags at_ on at_.asset_id = a.id
left join public.tags t on t.id = at_.tag_id
where a.status = 'published'
group by a.id;

grant select on public.published_assets to anon, authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles         enable row level security;
alter table public.user_roles       enable row level security;
alter table public.assets           enable row level security;
alter table public.asset_languages  enable row level security;
alter table public.images           enable row level security;
alter table public.tags             enable row level security;
alter table public.asset_tags       enable row level security;
alter table public.download_sources enable row level security;
alter table public.audit_logs       enable row level security;

-- profiles
create policy "profiles select own or admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles update own" on public.profiles
  for update using (id = auth.uid());

-- user_roles：客户端只读自己的行；写操作一律经 Worker (service role)
create policy "user_roles select own" on public.user_roles
  for select using (user_id = auth.uid());

-- assets
create policy "assets select published or admin" on public.assets
  for select using (status = 'published' or public.is_admin());
create policy "assets insert admin" on public.assets
  for insert with check (public.is_admin());
create policy "assets update admin" on public.assets
  for update using (public.is_admin());
create policy "assets delete admin" on public.assets
  for delete using (public.is_admin());

-- asset_languages
create policy "languages select published or admin" on public.asset_languages
  for select using (
    public.is_admin()
    or (
      status = 'published'
      and exists (
        select 1 from public.assets a
        where a.id = asset_id and a.status = 'published'
      )
    )
  );
create policy "languages insert admin" on public.asset_languages
  for insert with check (public.is_admin());
create policy "languages update admin" on public.asset_languages
  for update using (public.is_admin());
create policy "languages delete admin" on public.asset_languages
  for delete using (public.is_admin());

-- images
create policy "images select published or admin" on public.images
  for select using (
    public.is_admin()
    or exists (
      select 1
      from public.asset_languages l
      join public.assets a on a.id = l.asset_id
      where l.id = asset_language_id
        and l.status = 'published'
        and a.status = 'published'
    )
  );
create policy "images insert admin" on public.images
  for insert with check (public.is_admin());
create policy "images update admin" on public.images
  for update using (public.is_admin());
create policy "images delete admin" on public.images
  for delete using (public.is_admin());

-- tags / asset_tags：读公开，写 admin
create policy "tags select all" on public.tags
  for select using (true);
create policy "tags insert admin" on public.tags
  for insert with check (public.is_admin());
create policy "tags update admin" on public.tags
  for update using (public.is_admin());
create policy "tags delete admin" on public.tags
  for delete using (public.is_admin());

create policy "asset_tags select all" on public.asset_tags
  for select using (true);
create policy "asset_tags insert admin" on public.asset_tags
  for insert with check (public.is_admin());
create policy "asset_tags delete admin" on public.asset_tags
  for delete using (public.is_admin());

-- download_sources：仅登录用户可见 enabled 且所属 asset published
create policy "download_sources select" on public.download_sources
  for select using (
    public.is_admin()
    or (
      auth.uid() is not null
      and enabled
      and exists (
        select 1 from public.assets a
        where a.id = asset_id and a.status = 'published'
      )
    )
  );
create policy "download_sources insert admin" on public.download_sources
  for insert with check (public.is_admin());
create policy "download_sources update admin" on public.download_sources
  for update using (public.is_admin());
create policy "download_sources delete admin" on public.download_sources
  for delete using (public.is_admin());

-- audit_logs：admin 只读；写入由触发器 (security definer) / Worker service role 完成
create policy "audit_logs select admin" on public.audit_logs
  for select using (public.is_admin());

-- ============================================================
-- Storage：bucket images (public) + policies
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'images', 'images', true, 15728640,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "images bucket public read" on storage.objects
  for select using (bucket_id = 'images');

create policy "images bucket admin insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and public.is_admin());

create policy "images bucket admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'images' and public.is_admin());

create policy "images bucket admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'images' and public.is_admin());

-- ============================================================
-- 首个 Admin 提权函数（不在代码/前端硬编码邮箱）
-- 用法（SQL Editor，以 postgres 身份）:
--   select public.assign_first_admin('your-email@example.com');
-- ============================================================
create or replace function public.assign_first_admin(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = p_email limit 1;
  if v_uid is null then
    raise exception 'user with email % not found', p_email;
  end if;
  insert into public.user_roles (user_id, role) values (v_uid, 'admin')
  on conflict (user_id) do update set role = 'admin';
end;
$$;

revoke execute on function public.assign_first_admin(text) from anon, authenticated;
