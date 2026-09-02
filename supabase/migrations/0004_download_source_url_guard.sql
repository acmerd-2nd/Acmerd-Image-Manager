-- ============================================================
-- 0004: download_sources.url 安全校验（Phase 5，Owner 批准 Decision C）
--
-- 规则（严格）：
--   * 必须 https:// 开头
--   * host 必须【精确等于】允许列表中的某一项（禁止 contains / 前缀匹配）
--   * 拒绝 userinfo（@）、拒绝端口、拒绝控制字符
-- 允许主机（网盘官方分享域）：
--   quark: pan.quark.cn
--   baidu: pan.baidu.com, yun.baidu.com
-- 目的：防止 admin 误填 javascript:/data:/http: 或恶意域，
--       前端 window.open 时造成 XSS / 开放重定向。
--
-- 无表结构变更；仅新增校验触发器。幂等。
-- ============================================================

create or replace function public.guard_download_source_url() returns trigger
language plpgsql as $$
declare
  v_url  text := new.url;
  v_rest text;
  v_host text;
begin
  -- 基本非空与控制字符
  if v_url is null or length(btrim(v_url)) = 0 then
    raise exception 'DOWNLOAD_URL_INVALID: url is empty';
  end if;
  if v_url ~ '[\x00-\x1f\x7f]' then
    raise exception 'DOWNLOAD_URL_INVALID: url contains control characters';
  end if;

  -- 必须 https://
  if v_url !~* '^https://' then
    raise exception 'DOWNLOAD_URL_INVALID: only https is allowed';
  end if;

  -- 取 authority：https:// 之后到第一个 / ? # 之前
  v_rest := substring(v_url from 9); -- 去掉 'https://'
  v_rest := split_part(v_rest, '/', 1);
  v_rest := split_part(v_rest, '?', 1);
  v_rest := split_part(v_rest, '#', 1);

  -- 拒绝 userinfo 与端口
  if v_rest like '%@%' then
    raise exception 'DOWNLOAD_URL_INVALID: url must not contain credentials';
  end if;
  if v_rest like '%:%' then
    raise exception 'DOWNLOAD_URL_INVALID: url must not specify a port';
  end if;

  v_host := lower(v_rest);

  -- 精确主机白名单（禁止子串匹配）
  if v_host not in ('pan.quark.cn', 'pan.baidu.com', 'yun.baidu.com') then
    raise exception 'DOWNLOAD_URL_INVALID: host "%" is not allowed', v_host;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_download_source_url on public.download_sources;
create trigger guard_download_source_url
  before insert or update of url on public.download_sources
  for each row
  execute function public.guard_download_source_url();
