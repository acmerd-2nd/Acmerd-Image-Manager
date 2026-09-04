-- ============================================================
-- 0010: V1.1 Phase A — Credits 数据模型与原子 RPC
-- 依据: docs/v1.1/01-design-gate.md (Rev B) §3.2 / §10 + Owner 裁决:
--   * credit_accounts 与 profiles 分离（D7，提案 §53 推荐方案）
--   * balance numeric(12,2) CHECK (>= 0)——数据库层永不出现负余额（提案 §41）
--   * credit_transactions 只追加（Ledger，无 UPDATE/DELETE 授权）
--   * 裁决第四点: user_id ON DELETE SET NULL —— 用户永久删除后
--     Ledger 全量保留（个人账户/余额消失，财务式追溯不消失）
--   * H2 幂等协议: same key + same request → same result;
--     same key + different request → IDEMPOTENCY_CONFLICT
--     （唯一键命中 ≠ 自动幂等，必须参数一致性校验——Owner 裁决第二点）
--   * 退款幂等: 一个 debit 最多对应一个成功 refund（部分唯一索引）
--   * 原子扣除: 行锁 + 条件更新单语句，禁止应用层 SELECT→UPDATE 两步
--
-- 幂等: create if not exists / DO 块防重 / create or replace。可重放。
-- ============================================================

-- ------------------------------------------------------------
-- (1) credit_accounts —— 积分账户（与身份资料 profiles 分离）
--     行由 handle_new_user 触发器自动创建（见 (4)），任何建号路径
--     均有账户，Worker 端永无"缺账户"分支。
-- ------------------------------------------------------------
create table if not exists public.credit_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  balance    numeric(12,2) not null default 0 check (balance >= 0),
  unlimited  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists touch_credit_accounts_upd on public.credit_accounts;
create trigger touch_credit_accounts_upd
  before update on public.credit_accounts
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- (2) credit_transactions —— 积分流水（只追加 Ledger）
--     * user_id ON DELETE SET NULL（裁决第四点，非 CASCADE）
--     * idempotency_key unique —— 幂等协议载体（协议在 RPC 内校验参数一致性）
--     * 部分唯一索引: 一个 debit 至多一个 download_refund
-- ------------------------------------------------------------
create table if not exists public.credit_transactions (
  id              bigint generated always as identity primary key,
  user_id         uuid references auth.users(id) on delete set null,
  type            text not null,
  amount          numeric(12,2) not null,
  balance_after   numeric(12,2) not null,
  reference_type  text,
  reference_id    text,
  idempotency_key text unique,
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  constraint credit_transactions_type_check check (
    type in ('image_download','zip_download','package_download',
             'admin_adjustment','download_refund','seed_initial')
  )
);

create index if not exists idx_credit_tx_user_created
  on public.credit_transactions (user_id, created_at desc);

-- H2 退款幂等: 同一 debit（reference_id）至多一条 download_refund
create unique index if not exists uq_credit_refund_per_debit
  on public.credit_transactions (reference_id)
  where type = 'download_refund' and reference_id is not null;

-- ------------------------------------------------------------
-- (3) deduct_credits —— 原子扣除（SECURITY DEFINER 单事务）
--     调用方: Worker（service role）。身份防线:
--       a) execute 仅授 service_role（文件尾 grants）；
--       b) 函数内双保险: p_user_id 必须 = auth.uid() 或调用方为 service_role。
--     原子性: 单条 UPDATE（行锁串行化 + balance >= cost 条件），
--     并发双请求余额 1 时恰一成功，结构性无负余额。
--     幂等协议（H2）:
--       key 未存在            → 执行扣分并落 ledger
--       key 存在 + 五元组一致 → 返回原 balance_after（不重复扣）
--       key 存在 + 参数不一致 → raise IDEMPOTENCY_CONFLICT（Worker 映射 409）
--     unlimited = true → bypass（不扣不写扣账流水，Ledger 只含真实资金变动）
-- ------------------------------------------------------------
create or replace function public.deduct_credits(
  p_user_id        uuid,
  p_type           text,
  p_amount         numeric,
  p_idempotency_key text,
  p_ref_type       text default null,
  p_ref_id         text default null,
  p_metadata       jsonb default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_balance   numeric(12,2);
  v_unlimited boolean;
  v_existing  public.credit_transactions%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: deduct amount must be positive';
  end if;
  if p_type not in ('image_download','zip_download','package_download') then
    raise exception 'INVALID_TYPE: % is not a debit type', p_type;
  end if;

  -- 防线 b: 非本人且非 service_role 一律拒绝
  if auth.uid() is distinct from p_user_id
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: deduct_credits caller mismatch';
  end if;

  -- ---------- H2 幂等协议 ----------
  if p_idempotency_key is not null then
    select * into v_existing
      from public.credit_transactions
     where idempotency_key = p_idempotency_key;

    if found then
      if v_existing.user_id = p_user_id
         and v_existing.type = p_type
         and v_existing.amount = -p_amount
         and coalesce(v_existing.reference_type, '') = coalesce(p_ref_type, '')
         and coalesce(v_existing.reference_id, '') = coalesce(p_ref_id, '') then
        return v_existing.balance_after;           -- ② 同 key 同参 → 原结果
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT: key % was used with different parameters', p_idempotency_key;
    end if;
  end if;

  -- ---------- unlimited 旁路 ----------
  select unlimited, balance into v_unlimited, v_balance
    from public.credit_accounts
   where user_id = p_user_id;
  if not found then
    raise exception 'CREDIT_ACCOUNT_MISSING: user % has no credit account', p_user_id;
  end if;

  if v_unlimited then
    return v_balance;                              -- bypass，不写扣账流水
  end if;

  -- ---------- 原子扣除（行锁 + 条件更新，一步完成） ----------
  update public.credit_accounts
     set balance = balance - p_amount
   where user_id = p_user_id
     and balance >= p_amount
  returning balance into v_balance;

  if not found then
    raise exception 'INSUFFICIENT_CREDITS: user % balance below %', p_user_id, p_amount;
  end if;

  -- ---------- 落 ledger（并发同 key 由 unique 约束兜底） ----------
  begin
    insert into public.credit_transactions
      (user_id, type, amount, balance_after, reference_type, reference_id, idempotency_key, metadata)
    values
      (p_user_id, p_type, -p_amount, v_balance, p_ref_type, p_ref_id, p_idempotency_key, p_metadata);
  exception when unique_violation then
    -- 并发重复: 重查并按协议裁决
    select * into v_existing
      from public.credit_transactions
     where idempotency_key = p_idempotency_key;
    if v_existing.user_id = p_user_id
       and v_existing.type = p_type
       and v_existing.amount = -p_amount
       and coalesce(v_existing.reference_type, '') = coalesce(p_ref_type, '')
       and coalesce(v_existing.reference_id, '') = coalesce(p_ref_id, '') then
      return v_existing.balance_after;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT: key % was used with different parameters', p_idempotency_key;
  end;

  return v_balance;
end;
$$;

-- ------------------------------------------------------------
-- (4) handle_new_user 扩展 —— 建号同时创建积分账户（幂等重定义）
--     保留 0001 原语义（profiles + user_roles），仅追加 credit_accounts。
-- ------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  insert into public.user_roles (user_id, role) values (new.id, 'user');
  insert into public.credit_accounts (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- (5) adjust_credits —— 管理员 Set Balance（直接设定，非 +N）
--     调用方: Worker（service role，admin JWT 已在 Worker 层校验）。
--     ledger 记 admin_adjustment（差额正负皆可），metadata 含 from/to。
--     unlimited 变更不走本函数（不碰 balance）。
-- ------------------------------------------------------------
create or replace function public.adjust_credits(
  p_user_id  uuid,
  p_balance  numeric,
  p_reason   text default null,
  p_actor_id uuid default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_old       numeric(12,2);
  v_new       numeric(12,2);
  v_unlimited boolean;
begin
  if p_balance is null or p_balance < 0 then
    raise exception 'INVALID_BALANCE: balance must be >= 0';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'FORBIDDEN: adjust_credits requires admin or service role';
  end if;

  select balance, unlimited into v_old, v_unlimited
    from public.credit_accounts
   where user_id = p_user_id;
  if not found then
    raise exception 'CREDIT_ACCOUNT_MISSING: user % has no credit account', p_user_id;
  end if;

  update public.credit_accounts
     set balance = p_balance
   where user_id = p_user_id
  returning balance into v_new;

  insert into public.credit_transactions
    (user_id, type, amount, balance_after, reference_type, reference_id, metadata)
  values
    (p_user_id, 'admin_adjustment', v_new - v_old, v_new, 'profile', p_user_id::text,
     jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason, 'actor', p_actor_id));

  return v_new;
end;
$$;

-- ------------------------------------------------------------
-- (6) refund_credits —— ZIP 流中失败的自动退款（H2: 一 debit 一 refund）
--     * 强制 reference_type='transaction' 且指向原 debit 行；
--     * 原 debit 必须是下载扣账类型且 amount < 0；
--     * 部分唯一索引 uq_credit_refund_per_debit 结构性保证至多一次；
--     * 重复 refund 请求 → 唯一冲突 → 幂等返回原结果（不二次加钱）。
-- ------------------------------------------------------------
create or replace function public.refund_credits(
  p_debit_transaction_id bigint,
  p_idempotency_key      text default null,
  p_metadata             jsonb default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_debit    public.credit_transactions%rowtype;
  v_balance  numeric(12,2);
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'FORBIDDEN: refund_credits requires admin or service role';
  end if;

  select * into v_debit
    from public.credit_transactions
   where id = p_debit_transaction_id
     and type in ('image_download','zip_download','package_download')
     and amount < 0;
  if not found then
    raise exception 'DEBIT_NOT_FOUND: % is not a downloadable debit transaction', p_debit_transaction_id;
  end if;

  -- 幂等: 该 debit 已有 refund → 直接返回，不二次加钱
  if exists (
    select 1 from public.credit_transactions
     where type = 'download_refund' and reference_id = p_debit_transaction_id::text
  ) then
    select coalesce(balance_after, 0) into v_balance
      from public.credit_transactions
     where type = 'download_refund' and reference_id = p_debit_transaction_id::text
     order by id desc limit 1;
    return v_balance;
  end if;

  update public.credit_accounts
     set balance = balance + (-v_debit.amount)
   where user_id = v_debit.user_id
  returning balance into v_balance;

  if not found then
    -- 用户已被永久删除（credit_accounts cascade 消失）→ 无处退款
    raise exception 'CREDIT_ACCOUNT_MISSING: user of debit % no longer has an account', p_debit_transaction_id;
  end if;

  begin
    insert into public.credit_transactions
      (user_id, type, amount, balance_after, reference_type, reference_id, idempotency_key, metadata)
    values
      (v_debit.user_id, 'download_refund', -v_debit.amount, v_balance,
       'transaction', p_debit_transaction_id::text, p_idempotency_key, p_metadata);
  exception when unique_violation then
    -- 并发重复退款: 返回既有 refund 结果（幂等）
    select coalesce(balance_after, 0) into v_balance
      from public.credit_transactions
     where type = 'download_refund' and reference_id = p_debit_transaction_id::text
     order by id desc limit 1;
    return v_balance;
  end;

  return v_balance;
end;
$$;

-- ------------------------------------------------------------
-- (7) grants 收敛（铁律: 客户端对积分数据零写；RPC 仅 service_role）
--     注: 0002 default privileges 已给新表自动授权，此处显式收紧。
--     读面: credit_accounts 本人 / credit_transactions 本人+admin —— RLS 见 0012。
-- ------------------------------------------------------------
revoke all on public.credit_accounts, public.credit_transactions from anon, authenticated;
grant  select on public.credit_accounts, public.credit_transactions to authenticated, service_role;
grant  insert, update, delete on public.credit_accounts, public.credit_transactions to service_role;

revoke all on function public.deduct_credits(uuid, text, numeric, text, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.deduct_credits(uuid, text, numeric, text, text, text, jsonb) to service_role;
revoke all on function public.adjust_credits(uuid, numeric, text, uuid) from public, anon, authenticated;
grant  execute on function public.adjust_credits(uuid, numeric, text, uuid) to service_role;
revoke all on function public.refund_credits(bigint, text, jsonb) from public, anon, authenticated;
grant  execute on function public.refund_credits(bigint, text, jsonb) to service_role;

-- ============================================================
-- 0010 end. 幂等可重放；无既有表结构/策略改动。
-- ============================================================
