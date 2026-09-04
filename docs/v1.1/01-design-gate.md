# V1.1 Design Gate — ACMERD Image Manager

> **版本**: **Rev B**（2026-09-04）——已并入 Owner 裁决（APPROVED WITH REQUIRED ADJUSTMENTS）全部要求调整与 H1–H3 硬约束。Rev A 历史差异见 `02-owner-ruling-2026-09-04.md` 裁决原文。  
> **性质**: Design Gate（设计裁决文档），依据 `D:\000.下载内容\v1.1.txt`（V1.1 Change Proposal）输出。  
> **裁决状态**: ✅ **APPROVED WITH REQUIRED ADJUSTMENTS**（裁决原文已落档 `docs/v1.1/02-owner-ruling-2026-09-04.md`）。必改项已全部并入本 Rev B；**Phase A 可启动**。  
> **基线**: V1.0.0 = frozen production release（tag `v1.0.0` → `2065d44`；bundle `index-DosBFCeX.js`；Worker `94cb46b3`；DB 0001–0008 全 applied）。所有变更走新增 migration + 新版本发布，不在 V1.0 基线上原地修改。  
> **实施纪律**: 实施顺序沿用总纲固定流程（DB migration → 隔离库冒烟 → Worker/前端 → QA 证据 → 生产 migration → 线上抽查 → 结束报告）；**gate 边界即停，Phase A 收口后等 Owner 验收，不自动推进 Phase B**。

---

## 0. Owner 裁决摘要与硬约束（最高优先级，实施全程有效）

### 0.1 D1–D12 裁决结果

| #   | 裁决                         | 关键要求                                                                                                  |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | ✅                          | 数据模型 → 业务逻辑 → UI → 回归四阶段                                                                              |
| D2  | ✅                          | 轻量 i18n（`src/i18n/`），不引框架；**V1.1 新建 UI 第一天起即用 i18n key**（裁决 §10）                                      |
| D3  | ✅                          | provider + source_path 保留旧 storage_path 兼容；**source_url 仅作衍生值，不作核心事实字段**                              |
| D4  | ✅ with risk lock           | GitHub Image Repository 采纳；GitHub Token 仅 Worker Secret；串行/受控写入；持续评估大陆可访问性；**不提前引入 R2 / Worker 图片代理** |
| D5  | ✅                          | Collection 单层 / collection_id 可空 / `/asset/:slug` 永久兼容；未归组 published Asset → 首页"More Resources"（已批准）  |
| D6  | ✅                          | site_settings + Platform Controls，不恢复完整 Settings                                                      |
| D7  | ✅                          | credit_accounts + credit_transactions 独立模型；**ledger 不随用户级联删除（见 §3.2）**                                |
| D8  | ✅ with required changes    | Atomic RPC / Idempotency / **Refund 必须幂等** / **相同 key 参数冲突必须 409** / **禁止应用层 SELECT→UPDATE 扣分**       |
| D9  | ✅ with required correction | Worker 为公开注册唯一入口；**重新设计注册成功后的 session 语义——不得假设 admin.createUser() 返回 session**                        |
| D10 | ✅                          | Seed Users + permanent delete；**credit_transactions.user_id 改 ON DELETE SET NULL**                    |
| D11 | ✅                          | allowlist 24 → 34+（补齐 user.deleted / collection.* / credits.* / settings.\*）                          |
| D12 | ✅                          | 0009+ 分批 migration / NO-DRIFT / `/asset/:slug` 永久兼容                                                   |

### 0.2 非编号硬约束 H1–H3（Owner 新增，落库前锁死）

| #      | 硬约束                                                                                                                                                                                | 落点        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **H1** | Collection Cover 必须有"属于当前 Collection"**数据库级**约束：`collection.cover_image_id → image → asset → asset.collection_id = collection.id`（沿用 Phase 3 Asset Cover 同资产守卫思路，trigger 实现于 0009） | §3.4 / §7 |
| **H2** | Credits 幂等协议：**same key + same request → same result；same key + different request → 409 IDEMPOTENCY_CONFLICT**（唯一键命中不自动等于幂等，必须参数一致性校验）；refund 同样幂等：**一个 debit 最多对应一个成功 refund**    | §10       |
| **H3** | GitHub Image 写入顺序锁死：**remote success → DB success；remote failure → DB failure**，不得产生幽灵 image row；GITHUB_TOKEN 只在 Worker Secret；同一 Asset/Language 的写入必须串行                           | §6        |

### 0.3 产品规格钉死（裁决附加）

> **ZIP 消耗 = 所选图片数量 × ZIP 单张成本（`zip_download_cost_per_image`），不是固定 15。**  
> 后台控件命名钉死：`Single Image Cost` / `ZIP Per-image Cost` / `Package Download Cost`——杜绝"ZIP Download Cost 被误读为固定价"。  
> 语义：单张 1 / ZIP N 张 → N×单价 / Package 固定 15（默认值，后台可调）。

---

## 1. Phase / Goal / Scope / Out of Scope

| 项                | 内容                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**        | V1.1（内部编号 Phase 11+，tag `v1.1.0`；V1.0 冻结基线不动）                                                                                                                                                                                                                                    |
| **Goal**         | 在 V1.0 冻结基线之上增加：界面本地化（zh-CN 默认）、GitHub Image Repository、Collection 层级、Schedule 导航、User Provisioning（8 seed users + 永久删除）、Credits 体系、注册开关。产品模型：Collection → Asset → Language → Image（Repository），User → Credits → Download，Admin → Content / Users / Credits / Platform Controls。 |
| **In Scope**     | 新增 migration（0009+）、Worker 新端点/改造、前端 i18n 与新增页面、Admin 能力扩展、图片两阶段迁移脚本、回归验证                                                                                                                                                                                                        |
| **Out of Scope** | 多级文件夹（仅一层 Collection）、完整 Settings 系统恢复、Git LFS / R2 / S3 / Cloudflare Images、Worker 图片代理、付费/支付、积分充值、V1.0 已关闭 Phase 的重构                                                                                                                                                           |

### V1.0 冻结基础设施对照（不变）

| 冻结项                          | V1.1 对照结论                              |
| ---------------------------- | -------------------------------------- |
| published_assets / 双层可见性     | 语义零改动；Collection 只是新增组织维度              |
| is_admin()（含 disabled=false） | 复用，不改                                  |
| RLS 骨架 + grants              | 同范式扩展，不破坏                              |
| audit allowlist（24）          | 幂等超集扩展 24→34+（0007 先例）                 |
| disabled 门禁对偶                | 所有新 authed 端点强制复用 `authenticate()`     |
| Service Role Key 红线          | **GITHUB_TOKEN 同级红线：只进 Worker Secret** |
| 权限只靠 UI 隐藏 = 无效              | 注册开关、积分扣除服务端强制                         |

---

## 2. 决策项总览（已按 Owner 裁决更新）

见 §0.1。以下正文均为裁决后（Rev B）版本。

---

## 3. Schema 设计

### 3.1 现状事实（0001–0008）

- `images.storage_path text not null`：现语义为 Supabase Storage 路径。
- `profiles` / `user_roles`；`handle_new_user` 触发器注册时自动建 profile + role。
- 无 collections / credits / settings 表；注册走 GoTrue 公开 signup。
- 单图下载 = Worker 302 软门控；ZIP = Worker 流式生成。
- 0003 已有 Asset Cover 同资产守卫（H1 的实现先例）。

### 3.2 新增表（Rev B 修订处已标注）

```sql
-- 组织容器：Collection（单层）
collections (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  description    text,
  cover_image_id uuid references images(id) on delete set null,   -- 完整性由 H1 trigger 补强
  status         asset_status not null default 'draft',
  sort_order     integer not null default 0,
  created_by     uuid references profiles(id),
  created_at / updated_at timestamptz
)

-- images 表 ALTER（Rev B：删除 source_url，按裁决仅保留事实字段）
  provider     text not null default 'supabase_storage'   -- 'supabase_storage' | 'github'
  source_path  text                                        -- github: assets/{assetId}/{lang}/{file}
-- CHECK: provider='supabase_storage' → storage_path not null；provider='github' → source_path not null
-- 最终 URL 一律由 makeImageUrl(image) 动态计算——CDN 前缀/commit-pinned/jsDelivr 未来切换不碰 DB

-- 积分账户
credit_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  balance    numeric(12,2) not null default 0 check (balance >= 0),
  unlimited  boolean not null default false,
  created_at / updated_at
)

-- 积分流水（Rev B：user_id 改 ON DELETE SET NULL —— Owner 裁决第四点）
credit_transactions (
  id              bigint generated always as identity primary key,
  user_id         uuid references auth.users(id) on delete set null,  -- 用户删除后 ledger 保留
  type            text not null,      -- image_download / zip_download / package_download /
                                      -- admin_adjustment / download_refund / seed_initial
  amount          numeric(12,2) not null,          -- 负=扣 正=加
  balance_after   numeric(12,2) not null,
  reference_type  text,               -- image / asset / download_source / transaction(退款指向 debit)
  reference_id    text,               -- 退款时 = 原 debit 事务 id
  idempotency_key text unique,        -- 防重复（协议见 §10.1，非"命中即返回"）
  metadata        jsonb,
  created_at      timestamptz not null default now()
)
-- 退款幂等：download_refund 行强制 reference_type='transaction' 且 reference_id 指向 debit，
-- 加唯一部分索引：CREATE UNIQUE INDEX ... ON credit_transactions(reference_id)
--   WHERE type = 'download_refund'  → 一个 debit 最多一个成功 refund（H2）

-- 平台设置
site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
)
```

**profiles 扩展**：`account_origin text not null default 'registered' check (in ('registered','seed'))`。

**site_settings 种子**（幂等 INSERT … ON CONFLICT DO NOTHING）：

| key                           | 初始值     | UI 控件名（裁决钉死）              |
| ----------------------------- | ------- | ------------------------- |
| `registration_enabled`        | `true`  | Registration Enabled      |
| `schedule_navigation_enabled` | `false` | Show Schedule Navigation  |
| `single_image_download_cost`  | `1`     | **Single Image Cost**     |
| `zip_download_cost_per_image` | `1`     | **ZIP Per-image Cost**    |
| `package_download_cost`       | `15`    | **Package Download Cost** |

> 余额/价格用 `numeric(12,2)`（预留未来 0.5 类单价，免二次类型迁移）；初始均为整数。

**索引**：`assets(collection_id)`、`credit_transactions(user_id, created_at desc)`、`collections(status, sort_order)`、退款唯一部分索引（见上）。

### 3.3 Schema 决策要点（Rev B）

1. storage_path 保留 + 双 provider 并存（D3 方案 A 维持）；**无 source_url 列**（裁决：衍生值不落库）。
2. `balance CHECK (>= 0)` 维持；unlimited 旁路不写扣账流水。
3. credit_transactions 只追加 + **user_id ON DELETE SET NULL**（裁决第四点）：用户永久删除后 ledger 全量保留（user_id=null），reference/type/amount/balance_after/metadata/created_at 支持财务式追溯；删除时在 `user.deleted` 审计 metadata 记录**匿名化快照**（display_name 等），**邮箱不写进 ledger**（隐私裁决建议采纳——邮箱仅出现在 audit_logs 的 user.deleted metadata 中，audit 属安全记录非业务数据，保留 Owner 裁决原文中的"metadata.email"意图，见 §11.2 双轨说明）。

### 3.4 H1 —— Collection Cover 完整性约束（0009 内实现）

```sql
-- guard_collection_cover：cover 必须属于当前 Collection 下的某 Asset
create or replace function public.guard_collection_cover() returns trigger
language plpgsql as $$
begin
  if new.cover_image_id is not null then
    if not exists (
      select 1
      from public.images i
      join public.asset_languages l on l.id = i.asset_language_id
      join public.assets a on a.id = l.asset_id
      where i.id = new.cover_image_id
        and a.collection_id = new.id
    ) then
      raise exception 'collection cover must belong to an asset within this collection';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_collection_cover_ins_upd
  before insert or update on public.collections
  for each row execute function public.guard_collection_cover();
```

> 附带边界：Asset 换 Collection 时若其图片正被原 Collection 用作 cover，0009 需同款守卫拦截（`guard_asset_collection_move`：转移前检查 cover 引用），与 0003 Asset Cover/Publish 守卫同级。删除 image 时 FK `on delete set null` 自然失效 cover，无孤儿。

---

## 4. RLS 设计

沿用 0001/0002 范式（读公开/读本人，写 admin 或仅 service role）：

| 表                     | SELECT                                                                                                               | INSERT/UPDATE/DELETE                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `collections`         | `status='published'` 或 admin；另建 `published_collections` security_invoker 视图（仅返回含 ≥1 双层 published Asset 的 Collection） | admin + 审计触发器范式                                                     |
| `images`（新列）          | 策略零改动；published_assets 视图不引用新列，无漂移面                                                                                  | admin（不变）                                                           |
| `site_settings`       | anon + authenticated 可读（5 key 非敏感）                                                                                   | 无客户端策略，仅 Worker service role                                        |
| `credit_accounts`     | `user_id = auth.uid()`                                                                                               | 无客户端策略；行由 `handle_new_user`（security definer）自动创建；变更仅经 Worker + RPC |
| `credit_transactions` | 本人读自己 + admin 读全部（**用户删除后：admin 可读全部含 user_id=null 行**）                                                              | 无客户端策略；仅积分 RPC（security definer）写入                                  |

普通用户对 credit_accounts / credit_transactions / site_settings **零写权限**（grants 层 REVOKE，0002 范式）。`handle_new_user` 扩展：建号同时创建 credit_account 行。

---

## 5. Worker 改动面

### 5.1 现有端点改造

| 端点                               | 现状                | V1.1 改动                                                                                                                   |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/downloads/image/:id`   | 302 软门控           | 积分门控：authenticate → 实时读价 → `deduct_credits` 原子 RPC（幂等协议 §10.1）→ 302 图片 URL（provider 决定）。余额不足 → 结构化 `insufficient_credits` |
| `POST /api/downloads/zip`        | 登录 + 流式           | authenticate → 计数 × ZIP Per-image Cost → **逐对象 HEAD 预检** → 原子扣总积分 → 流式 ZIP；流中失败 → `download_refund`（幂等，§10.2）             |
| `POST /api/admin/storage/delete` | 删 Storage 对象      | 按 provider 分派：supabase_storage 原逻辑 / github 走 Contents API DELETE；预留更名 `/api/admin/images/delete`                         |
| `authenticate()`                 | JWT+role+disabled | 零改动，新端点全复用                                                                                                                |

### 5.2 新增端点（Rev B：D9 已按裁决修正）

| 端点                                               | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/register`                        | **注册唯一入口，session 语义按裁决重设计**：  
① check `registration_enabled`（实时）→ ② service role 调 GoTrue **admin createUser**（`email_confirm` 沿用现配置）→ ③ **校验** profile / user_roles / credit_account 三行已由 `handle_new_user` 触发器就位（缺失即整体失败回滚）→ ④ 返回 `{ ok: true }`（**不返回 session**）→ ⑤ 前端跳转 Login（携带 email 预填）。  
**V1.1 不做"注册即自动登录"**；若未来需要，须另行设计并实测验证"创建用户 → 建立 session"流程（裁决原文明确），走 Change Proposal。  
GoTrue `Allow new users to sign up` 关闭（结构性关闭直调 `/auth/v1/signup`）；Worker gate 为第二层。 |
| `GET /api/settings/public`                       | 启动拉取 `registration_enabled` / `schedule_navigation_enabled` + 三项价格（或经 RLS 直读，实施时定，推荐后者）                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/downloads/package/:assetId/:sourceId` | authenticate → check source（enabled + published，RLS 兜底）→ 原子扣 `package_download_cost` → 返回跳转 URL。授权跳转即消耗，不退款                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/admin/users/:id/credits`              | Set Balance（非 +N）→ `adjust_credits` RPC，type=`admin_adjustment`，metadata 记 from/to/reason，action=`credits.adjusted`                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/admin/users/:id/unlimited`            | Toggle unlimited（不碰 balance），action=`credits.unlimited_changed`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /api/admin/users/:id`                    | 永久删除（§11.2，Rev B：ledger SET NULL 语义）                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PUT /api/admin/settings`                        | 平台开关/价格修改，action=`settings.updated`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST/PUT/DELETE /api/admin/images`（GitHub 代理）   | Admin 上传/删除：浏览器 → Worker（admin JWT）→ GitHub Contents API（Token 在 Secret）。**H3 顺序锁死，见 §6.1**                                                                                                                                                                                                                                                                                                                                                                                    |

### 5.3 Worker 新增 Secret

- `GITHUB_TOKEN`（Contents API 读写，scope 仅限 `acmerd-2nd/-Photo-Acmerd-Image-Manager`）——`wrangler secret put`；**绝不进浏览器/Git/wrangler.toml**（与 Service Role Key 同级红线，Owner D4 risk lock）。

---

## 6. GitHub Image Repository（D4 ✅ with risk lock）

### 6.1 采用设计 + H3 硬约束

- 仓库：`acmerd-2nd/-Photo-Acmerd-Image-Manager`（独立于应用代码仓库）。
- 目录：`assets/{asset-uuid}/{langCode}/{file}`。
- **URL 统一出口**：`src/lib/image-source.ts` `makeImageUrl(image)` 按 `provider` 动态计算最终 URL（`source_url` 不落库，Rev B）。页面永不自行拼接。
- 浏览/下载职责分离：浏览 = 浏览器直连；下载 = Worker 授权扣分后 302/流式。
- **H3 写入顺序锁死**（裁决第六点三条硬约束）：
  1. `GITHUB_TOKEN` 只在 Worker Secret；
  2. **同一 Asset/Language 的 GitHub 写入必须串行**——Worker 内以 `assetId/langCode` 为键做互斥（内存锁 / Durable Object 不引入，V1.1 用 Worker 级串行队列即可；Contents API 官方明示并发创建/删除会冲突）；
  3. **remote success → DB success；remote failure → DB failure**：上传流程 = 先 GitHub Contents API PUT → 成功后才 INSERT images 行；GitHub 失败/超时不写 DB，杜绝幽灵图片。删除流程反向同理：先 DB 标记/删除 → 远端删除 → 远端失败则回报 Admin 重试（残留对象可对账清理）。
- V1.1 不在 DB 记 GitHub commit（裁决维持 §67）。

### 6.2 风险评估（Owner D4 risk lock 版）

| #  | 风险                                         | 评估   | 处置                                                                                                                   |
| -- | ------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| R1 | **大陆可访问性**：`raw.githubusercontent.com` 不可靠 | 🔴 高 | **按裁决：继续评估，不提前引入 R2 / Worker 图片代理**。`makeImageUrl` 已收口 URL 出口，未来切换只改一处；Phase B 交付时附实测数据（大陆网络 raw 可达性采样），供 Owner 后续决策 |
| R2 | 仓库容量（建议 <1–5 GB，硬限 100 GB）                 | 🟡 中 | 15 MB/文件上限 + webp 优先；容量红线写入 HANDOVER                                                                                 |
| R3 | Git 历史膨胀                                   | 🟡 中 | 图片只增不改；清理时整库重建（运维文档）                                                                                                 |
| R4 | raw CDN 缓存 ~5 min / 匿名限速                   | 🟡 中 | 不可变内容用 commit-pinned URL 长缓存（helper 内分支，不动 DB）                                                                       |
| R5 | Contents API 并发冲突                          | 🟢   | H3-2 串行写入约束（§6.1）                                                                                                    |
| R6 | 不引入 LFS                                    | 🟢   | 明确排除（LFS 免费带宽 1 GB/月更脆弱）                                                                                             |

**定位钉死（裁决）**：GitHub = 存储层（Binary Storage），**不是 CDN**；该定位与 R1 风险一并正式写入 V1.1 规格。

---

## 7. Collection 层级（D5 ✅）

- 单层；`assets.collection_id uuid null`——**可空，`collection_id = null` 完全合法**（裁决第八点：老数据不强迫重新分类）。
- `/asset/:slug` **永久兼容**；仅新增 `/collection/:slug`；无嵌套 URL。
- 三层可见性：Collection published + Asset published + Language published；`published_collections` 视图承载；`published_assets` 零改动。
- 职责锁死：Collection = 组织容器；cover 完整性见 §3.4（H1）。
- **首页信息架构（裁决钉死）**：`Collections`（Collection Cards）→ `More Resources`（未归组 published Asset Cards）→ `/asset/:slug` 不变。
- Admin：Collections 管理页（CRUD + 排序 + Archive + 指定封面）；Asset 编辑页 Collection 下拉；**转移 Asset 出 Collection 前受 cover 引用守卫拦截**（§3.4）。

## 8. Schedule 导航（Rev B 按裁决第九点修订）

- `site_settings.schedule_navigation_enabled`（默认 false）。
- **OFF**：公开导航隐藏 + `/schedule` 返回**轻量 Coming Soon / unavailable 产品状态**（正常 200 页面态，**非 404/403，不做特殊权限逻辑**——裁决：这只是产品显示策略，不是安全控制，不得让 `nav disabled = page forbidden`）。Admin 登录态可见正常管理视图。
- **ON**：正常 Schedule 页（V1.1 为 Coming Soon 静态内容）。
- 控制项并入 Admin Console **Platform Controls** 区域。

## 9. Settings / Platform Controls + 注册开关（D6 ✅ / D9 ✅ with correction）

### 9.1 Platform Controls（控件名裁决钉死）

| 控件                        | key                           | 默认    | 生效                                      |
| ------------------------- | ----------------------------- | ----- | --------------------------------------- |
| Registration Enabled      | `registration_enabled`        | true  | 即时（Worker 实时读）                          |
| Show Schedule Navigation  | `schedule_navigation_enabled` | false | 即时                                      |
| **Single Image Cost**     | `single_image_download_cost`  | 1     | 即时（以扣分时刻 DB 值为准）                        |
| **ZIP Per-image Cost**    | `zip_download_cost_per_image` | 1     | 即时；**ZIP 总价 = 所选数量 × 此单价，规格写死，不是固定 15** |
| **Package Download Cost** | `package_download_cost`       | 15    | 即时                                      |

### 9.2 注册开关（D9 修正版）

- 双层强制：① GoTrue `Allow new users to sign up` 关闭（结构性关闭直调 `/auth/v1/signup`）；② Worker `POST /api/auth/register` 实时检查 `registration_enabled`，OFF → 403 `registration_disabled`。
- 前端注册按钮保留，点击后提示"当前暂未开放注册。/ Registration is currently unavailable."
- **Admin 不受影响**：Admin provisioning 走 service role 的 GoTrue admin API，与公开 signup 开关无关。
- **注册成功后行为（裁决修正）**：返回"注册成功"→ 前端进入 Login；**不自动建 session**（见 §5.2）。

## 10. Credits Atomicity（D8 ✅ with required changes，H2 落地）

### 10.1 原子扣除 + 幂等协议（Rev B 核心修订）

`deduct_credits(p_user_id, p_type, p_amount, p_idempotency_key, p_ref_type, p_ref_id, p_metadata)` SECURITY DEFINER RPC，单事务：

```sql
-- 原子扣分（禁止应用层 SELECT→UPDATE 两步——Owner 裁决钉死）
update credit_accounts
   set balance = balance - p_amount
 where user_id = p_user_id
   and unlimited = false
   and balance >= p_amount
returning balance;
-- 0 行 → raise 'INSUFFICIENT_CREDITS'
-- 成功 → insert credit_transactions(…, idempotency_key = p_idempotency_key)
```

**H2 幂等协议（裁决钉死，进 V1.1 硬规则）**——唯一键命中 ≠ 自动幂等，必须参数一致性校验：

```text
幂等键绑定五元组：idempotency_key + user_id + type + amount + reference

① 首次请求（key 不存在）      → 执行扣分，创建 ledger 行
② 重复请求（key 存在，且
   user_id/type/amount/reference
   全部一致）                 → 不再扣分，返回原结果（原 balance_after）
③ key 存在但任一参数不一致    → 409 IDEMPOTENCY_CONFLICT（拒绝，绝不返回"首次结果"）
```

实现方式：RPC 内先按 key 查既有行 → 存在则比对五元组（一致性快照存于该行 type/amount/reference/metadata）→ 一致返回原结果，不一致 raise `IDEMPOTENCY_CONFLICT`（Worker 映射 409）。并发同 key 由 unique 约束兜底（后者捕获唯一冲突后重查比对）。unlimited=true 旁路不写流水（Ledger 只含真实资金变动）。

### 10.2 退款幂等（裁决第三点，H2 组成部分）

- `download_refund` 行强制 `reference_type='transaction'` 且 `reference_id = 原 debit 事务 id`。
- **部分唯一索引**：`UNIQUE (reference_id) WHERE type='download_refund'` → **一个 debit 最多一个成功 refund**，浏览器 retry / 重复退款请求命中即返回首次退款结果，积分无法凭空增加。
- refund RPC 与 deduct RPC 同事务范式，写入前检查 debit 存在且类型匹配。

### 10.3 各下载类型扣除时机（维持 Rev A，Owner 批准）

| 类型      | 时机                                                 | 失败处理                       |
| ------- | -------------------------------------------------- | -------------------------- |
| 单图      | 预检可解析后扣 1 → 302                                    | 302 后传输失败不追踪（与 V1.0 软门控一致） |
| ZIP     | **逐对象 HEAD 预检 → 原子扣（数量 × ZIP Per-image Cost）→ 流式** | 流中异常 → 幂等 refund 自动退款      |
| Package | 校验 source → 原子扣 → 返回跳转                             | 授权跳转即消耗，不退款                |

### 10.4 无限积分 + UI

- `unlimited=true` bypass 全部扣分路径，balance 不动；关闭即恢复。
- 余额不足文案 zh/en；下载按钮**事前明示价格**（ZIP 显示 `N selected · Cost: N×单价 credits`）；单图不弹确认框。
- 右上角 `◉ 42` / `Credits ♾`；Admin Users 列含 Credits / Unlimited / Origin + Set Balance / Toggle Unlimited / View Credit History。

## 11. User Provisioning / 永久删除 / 审计（D10 ✅）

### 11.1 8 个 Seed Users

- 实施期一次性脚本（`scripts/v11-seed-users.mjs`，本地运行）：`demo01…demo08@…`，role=user、disabled=false、`account_origin='seed'`、credits=0、unlimited=false。**密码不进 Git/migration**，随机生成一次性交付 Owner。
- migration 只建 `account_origin` 列，不含账号数据；seed 用户无特殊权限类别。

### 11.2 永久删除（Rev B：ledger SET NULL 语义）

`DELETE /api/admin/users/:id`（Worker，service role 单事务）：

1. best-effort 撤销会话（GoTrue admin logout）；
2. 删 `auth.users` 行 → cascade 清理 profiles / user_roles / credit_accounts（个人账户消失）；**credit_transactions 因 `ON DELETE SET NULL` 全量保留（user_id=null），Ledger 不消失**（裁决第四点）；
3. audit_logs 保留；
4. 写 `user.deleted` 审计，metadata 含 `email + display_name + ledger_snapshot_note`（audit 为安全记录，按裁决 §61 保留 email 识别能力；**ledger 的 metadata 不含邮箱**，仅匿名化快照——双轨隐私边界，见 §3.3-3）；
5. last-admin 保护沿用 `admin_user_mutation` 锁内普查语义。

### 11.3 审计 allowlist 扩展（24 → 34+，幂等超集 DO 块）

新增：`collection.created / collection.updated / collection.deleted / collection.published / collection.archived / credits.adjusted / credits.unlimited_changed / user.provisioned / user.deleted / settings.updated`（图片增删沿用 image.uploaded / image.deleted）。实施顺序：migration 先于写新审计的代码。

## 12. i18n（D2 ✅ + 裁决第十点加条）

- `src/i18n/{zh.ts, en.ts, index.ts}`；key 范式 `nav.* / download.* / auth.* / credits.*` 等。
- **硬规则（裁决新增）：V1.1 新建的任何 UI（Admin / Credits / Collection / Schedule / 所有新页面与文案）从第一天起即使用 i18n key**，禁止"先写中文后补国际化"。
- `uiLocale`（localStorage `acmerd.ui.locale`，默认 zh-CN）与 `assetLanguage`（`?lang=`）**完全独立，冻结规则**；切换 UI 不刷新页面、不影响 `?lang=de`。
- 控件：左上角 Apple 风格 Switch（中 | EN），不做下拉；localStorage 缺省 → zh-CN，切换后持久化。

## 13. Migration 编排与兼容性（D12 ✅）

### 13.1 Migration 计划（Rev B 修订处标注）

| 编号                           | 内容                                                                                                                                                                      | 阶段              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 0009_v11_foundation.sql      | collections + assets.collection_id + images 新来源列（**无 source_url**）+ profiles.account_origin + 索引 + **H1 guard_collection_cover / guard_asset_collection_move triggers** | Phase A         |
| 0010_credits.sql             | credit_accounts + credit_transactions（**user_id ON DELETE SET NULL + 退款部分唯一索引**）+ handle_new_user 扩展 + deduct/adjust/refund RPC（幂等协议 §10.1/10.2）                        | Phase A         |
| 0011_settings.sql            | site_settings + 5 key 种子                                                                                                                                                | Phase A         |
| 0012_collections_rls.sql     | collections/credits/settings RLS + published_collections 视图 + grants REVOKE                                                                                             | Phase A         |
| 0013_audit_allowlist_v11.sql | allowlist 24→34+                                                                                                                                                        | Phase A（先于相关代码） |
| 0014+                        | 数据修正类（如需）                                                                                                                                                               | 按需              |

### 13.2 兼容性不变量（C1–C10，维持并按裁决强化）

| #   | 不变量                                                                          | 验证           |
| --- | ---------------------------------------------------------------------------- | ------------ |
| C1  | `/asset/:slug` 与 `/api/downloads/image/:id` 形态不变                             | 回归矩阵         |
| C2  | 双层可见性 NO-DRIFT（0008→快照→0009–0013→快照，Guest 视角逐字节一致）                           | 隔离库快照对比      |
| C3  | 存量 images 行（provider=supabase_storage）URL 解析与 V1.0 一致                        | 隔离库 + 线上抽查   |
| C4  | RLS/grants/allowlist 只增不破；普通用户对 credits/collections/settings 零写              | 权限矩阵         |
| C5  | 直调 GoTrue `/auth/v1/signup` 被结构性拒绝；Worker 端点 OFF 时 403；**注册成功响应不含 session**  | 线上 E2E       |
| C6  | 并发扣分：余额 1 双请求恰一成功、无负余额                                                       | 隔离库并发用例      |
| C7  | **幂等三态**：同 key 同参 → 原结果；同 key 异参 → 409；refund：一 debit 至多一 refund、retry 不重复加钱 | 隔离库用例（H2 验证） |
| C8  | disabled 门禁覆盖全部新端点                                                           | 线上 E2E       |
| C9  | 图片**两阶段迁移**（见 §13.3）对账一致；cover 守卫（H1）负样本被拒                                   | 对账脚本 + 隔离库   |
| C10 | V1.0 回归矩阵（Phase 10 六套）各阶段收口全绿                                                | 回归报告         |

### 13.3 图片两阶段迁移（Rev B 按裁决第七点升级）

```
Stage 1（复制+验证，不改任何线上语义）
  Supabase Storage 读出 → 写 GitHub Contents API → HEAD/Hash 双端校验 → Migration Report（逐对象对账）

Stage 2（切换+验证，需 Owner 单独批准执行）
  DB images.provider 切 'github'（source_path 落库）→ 线上 read verification（makeImageUrl 实测 200）
  → 全部通过后才进入 Storage cleanup（删除 Supabase 原对象，时点由 Owner 裁决）
```

**禁止**"上传 GitHub → 立刻删除 Supabase"。生产仅 1 张图，第一次迁移即作为完整流程演练（裁决明示）。回退路径：Stage 2 前任一时点均可回切 provider='supabase_storage'（原对象未删）。

## 14. 分阶段实施建议（D1 ✅）

```
Phase A  数据/基础设施：0009–0013 + makeImageUrl 双 provider + i18n 骨架（新 UI 全量 key 化）
Phase B  业务逻辑：GitHub 上传/删除代理（H3 串行）→ 图片两阶段迁移（Stage 1）→ Credits/下载扣分（H2）→ 注册 Gate（D9 修正版）→ User Provisioning
Phase C  UI：中英切换 → Collection UI → Schedule → Credits UI → Admin（Platform Controls / Users 扩展 / Collections / Image Repository 更名）
Phase D  迁移/回归：Stage 2 图片切换 → C1–C10 全量验证 + 线上抽查 + v1.1.0 tag
```

每阶段收口按固定流程，**gate 边界即停**。

## 15. Gate Status

| 项                    | 状态                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design Gate Rev A 提交 | ✅ 2026-09-04                                                                                                                                                                                |
| Owner 裁决             | ✅ **APPROVED WITH REQUIRED ADJUSTMENTS**（原文落档 `02-owner-ruling-2026-09-04.md`）                                                                                                              |
| 必改项并入（Rev B）         | ✅ 注册 session 语义（§5.2/§9.2）· Credits 幂等/退款（§10，H2）· Ledger 删除策略（§3.2/§11.2）· Collection Cover 完整性（§3.4，H1）· D4 风险锁（§6）· 两阶段迁移（§13.3）· i18n 第一天规则（§12）· ZIP 语义钉死（§0.3/§9.1）· Schedule 产品态（§8） |
| 代码 / migration 实施    | 🚫 尚未开始——**Rev B 已批准，Phase A 可启动**（启动时仍需 Owner 对阶段开工的常规触发指令）                                                                                                                                |
| 生产数据库 / 图片迁移         | 🚫 零触碰；图片 Stage 2 需 Owner 单独授权                                                                                                                                                              |

> **下一步**：Owner 触发 Phase A 开工 → 按序实施 0009–0013 → 隔离库冒烟（含 C6/C7/C9 + H1/H2 负样本）→ 交 Phase A 收口报告，等待 Owner 验收后再进入 Phase B。








