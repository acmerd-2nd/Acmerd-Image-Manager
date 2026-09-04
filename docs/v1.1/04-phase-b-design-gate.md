# V1.1 Phase B Design Gate — GitHub Image Repository & Credits/Download Integration

- **日期**: 2026-09-04
- **状态**: 🟡 **PENDING OWNER REVIEW**（Phase B 开工前置 Gate，Owner 明确要求单独审批）
- **前置**: Phase A = CLOSED（Owner 验收通过，见 §0）；Design Gate Rev B（01）继续有效，本文件只做 Phase B 增量裁决，不推翻 Rev B 任何结论。
- **纪律**: 本 Gate 为纯文档；在 Owner 批准前零代码改动、零生产库触碰、零图片上传。

---

## §0 Phase A 收口记录（Owner 裁决，2026-09-04）

- **✅ V1.1 Phase A = CLOSED**。48/48 隔离库冒烟通过（H1/H2/C6/Refund/RLS/NO-DRIFT/Migration 幂等）全部确认。
- H2 幂等三态 + C6 无负余额 + 一 debit 一 refund 正式冻结为 **V1.1 Credits 底层不变量**。
- `storage_path` 解除 NOT NULL + provider/source_path 双模型获 Owner 接受（旧数据 supabase_storage 语义不变，新图走 github，不为换仓库破坏 V1.0 数据）。
- H1（cover 同 Collection 约束 + Asset 移出守卫）获 Owner 认可。
- **Phase A 不得重开。**

## §1 Phase B 范围分解与停止点（Owner 钉死节奏）

| 子阶段 | 内容 | 完成后 |
| --- | --- | --- |
| **PB-1 核心** | GitHub Upload / Delete / makeImageUrl 接线 / Provider-aware Download | **STOP → Owner 检查** |
| **Stage 1** | Supabase → GitHub 复制 + HEAD/Hash 校验 + Migration Report | **STOP → Owner 检查** |
| **Stage 2** | DB provider 切换 github + 线上 read verification | 🚫 **单独 Owner 授权**，之后才允许 Storage cleanup |

明确排除：生产库 schema 变更（0014 之外）、Credits 计费语义变更（Rev B D8 已冻结，Phase B 只做接线）、Stage 2 自动执行。

**实现事实基础**（已核对，Gate 结论建立于此）：
- Worker 全部经 PostgREST/REST 调 Supabase——**无交互式 DB 事务、无会话级连接**，因此 `pg_advisory_lock(session)` 与单 isolate 内存 Map 均不可用（前者无稳定会话，后者跨实例失效）。
- 单图下载 = `/api/downloads/image/:id` 校验 published 双层 → 302 到 Storage public URL。
- ZIP = 预检（DB file_size + HEAD）→ 有界并发（4）流式 fetch → store 模式打包；无部分成功语义。
- Admin 图片上传现状：浏览器直传 Supabase Storage（`src/features/assets/storage.ts`），不经 Worker。

---

## §2 PB-1 跨 Worker 实例并发控制（Owner 必答项 1）

**问题**：同一 Asset + Language 并发两次上传 → 两个 isolate 同时打 GitHub Contents API 同一路径 → 422/409 冲突（GitHub 官方明示并发 create/delete 会冲突）。

**裁决建议：Supabase 租约表（lease table），单语句原子抢占，跨 isolate 天然互斥。**

```sql
-- 0014（Phase B 实施，本 Gate 仅立项）
create table if not exists public.github_write_leases (
  resource_key text primary key,          -- 'al:{asset_language_id}'
  owner_id     text not null,             -- Worker 请求 id（uuid）
  expires_at   timestamptz not null       -- now() + interval '120 seconds'
);
```

抢占（单条原子 upsert，REST 单语句即可）：

```sql
insert into public.github_write_leases as l (resource_key, owner_id, expires_at)
values ($1, $2, now() + interval '120 seconds')
on conflict (resource_key) do update
  set owner_id = excluded.owner_id, expires_at = excluded.expires_at
  where l.expires_at < now()
returning owner_id;
```

- 返回行且 owner_id = 本请求 → 抢到锁；0 行 → 409 `LEASE_BUSY`（另一写正在进行或租约未过期）。
- 完成/失败后 `delete where resource_key=$1 and owner_id=$2`（仅持有者可释放）。
- 崩溃安全：Worker isolate 死亡不释放 → 租约 120s 自动过期，不产生死锁。
- 锁粒度 = asset_language：不同 Asset/Language 并发上传互不阻塞；同 Asset/Language 严格串行。
- execute 仅授 service_role（0006 范式）。
- **第二层防线**：GitHub 侧 422 "already exists" / 409 → 重取 file sha 重试一次（见 §5），租约失效兜底。

**否决项**：内存 Map（Owner 已点名）；Durable Objects（引入新基础设施，与项目最小依赖原则冲突）；`pg_advisory_lock` 会话锁（REST 无稳定会话）。

## §3 PB-2 Remote Success / DB Failure 补偿（Owner 必答项 2）

**问题**：GitHub PUT ✅ → DB INSERT ❌ → GitHub 有文件、DB 无记录 = 孤儿对象。

**裁决建议：DB 先行 pending 态 + 单向状态机 + 对账清扫，补偿动作是"收敛到一致"，而不是笼统"整体失败"。**

新增 `images.status` 列（0014）：`uploading | ready | failed`（存量行一次性置 ready；公开视图/下载路径一律过滤 `status='ready'`——pending 行对外不存在，符合 H3"DB 不落成功态"）。

```
[1] 抢租约
[2] INSERT images(provider='github', status='uploading', source_path, file_size, …)
[3] PUT GitHub Contents API
    ├─ 失败（网络/4xx/5xx 重试穷尽）
    │     → UPDATE images SET status='failed'（保留行作审计，公开不可见）
    │     → 释放租约 → 返回失败。GitHub 侧无对象（PUT 本身没成功）→ 无孤儿
    └─ 成功 → [4] UPDATE images SET status='ready' → [5] 释放租约
崩溃窗口（[3] 成功后、[4] 前进程死亡）:
    → 行停留在 uploading，租约 120s 过期
    → 对账清扫（下节）收敛
```

**对账清扫（reconciliation sweeper）**——Worker scheduled handler（cron，如每 10 分钟）：
1. 取 `status='uploading'` 且租约已过期的行；
2. GET GitHub 该 path：存在且 sha 与 DB 记录一致 → 置 `ready`（上传实际已成功）；
3. 不存在 → 置 `failed`（PUT 实际未完成）；
4. `status='failed'` 但 GitHub GET 发现对象存在（罕见：PUT 成功但更新失败前崩溃）→ **补偿删除**该 GitHub 文件（幂等，见 §4），删完保持 failed；
5. 每次动作写审计（复用 allowlist，如需扩展 action 在 0014 一并加）。

**要点**：任何时刻系统状态都是"可判定的"——pending 行 + 租约过期 = 必有 sweeper 收敛路径；不会出现永久性 DB/GitHub 互相矛盾且无人处理的状态。

## §4 PB-3 GitHub 上传/删除幂等（Owner 必答项 3）

- **上传（PUT create）**：422 "already exists" → GET 该文件 → 内容 sha 与本次上传内容计算的 git blob sha 一致 → **视为成功**（幂等重放）；不一致 → 410 风格错误 `GITHUB_PATH_CONFLICT`（路径被不同内容占用，人工介入）。
- **更新（PUT with sha）**：先 GET 取 sha；GET 404 → 按 create 走。
- **删除（DELETE）**：GitHub 返回 404 → **视为成功**（目标态就是"不存在"）；成功返回 sha → 正常。
- 所有判定以 GitHub 响应为准，禁止"假设成功"。
- 重试整体最多 1 轮；再失败交给 sweeper（§3）。

## §5 PB-4 GitHub API 冲突/重试行为（Owner 必答项 4）

| 情形 | 行为 |
| --- | --- |
| 409/422 并发写冲突（理论上被租约消除，兜底） | 重新 GET sha → 重试 1 次 |
| 403 且 `x-ratelimit-remaining: 0` | **立即失败** `GITHUB_RATE_LIMITED`，不重试（防重试风暴），响应带 reset 时间 |
| 5xx / 网络错误 | 指数退避重试，最多 3 次（0.5s/1s/2s），计入 Worker CPU/子请求预算 |
| 401/403 权限（非限流） | 立即失败 `GITHUB_AUTH_FAILED`，不重试（配置错误重试无意义） |
| 重试穷尽 | 走 §3 失败路径（status='failed' + 释放租约），不留给调用方挂起 |

约束：单次上传的 GitHub 子请求总数上限 8（PUT/GET/重试合计），防 Worker 50 子请求预算耗尽。

## §6 PB-5 makeImageUrl Provider 感知行为与向后兼容（Owner 必答项 5）

Phase A 已落 `src/lib/image-source.ts`，Phase B 接线 + 冻结兼容承诺：

1. **`provider='supabase_storage'` 行**：解析出的 public URL 与 V1.0 现网**逐字节相同**（`{SUPABASE_URL}/storage/v1/object/public/images/{path}`，去 bucket 段约定不变）——零迁移、零回归风险。
2. **`provider='github'` 行**：默认 `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{source_path}`；`VITE_GITHUB_IMAGE_CDN_BASE` 设置时整体切换 CDN 前缀（R1 大陆可访问性预留口，切换只改 env + helper 一处，不动 DB）。
3. **`source_url` 永不落库**（Rev B D3 冻结）：衍生值一律 makeImageUrl 动态计算。
4. V1.0 UI（Lightbox 等）继续读 ImageRow.storage_path 路径不受影响；provider 感知切换在 PB-1 内完成（Lightbox/AssetCard 改走 makeImageUrl，属 Owner 已列的 "Image Source Switching" 范围）。
5. 环境变量清单（Phase B 新增，全部进 Wrangler/Vite 配置，不入 Git）：`GITHUB_TOKEN`（仅 **Worker Secret**，H3 铁律）、`GITHUB_IMAGES_OWNER/REPO/BRANCH`、`VITE_GITHUB_IMAGES_*`（前端）、`VITE_GITHUB_IMAGE_CDN_BASE`（可选）。

## §7 PB-6 GitHub 托管图的单图/ZIP 下载行为（Owner 必答项 6）

**Credits 语义零变更**（Rev B D8 冻结不变量）：单图 302 前扣 1（Single Image Cost）、ZIP = 所选数量 × ZIP Per-image Cost 预检后扣、Package 跳转即消耗。只换"扣完之后 302 到哪"。

| 路径 | supabase_storage 行 | github 行 |
| --- | --- | --- |
| 单图 `/api/downloads/image/:id` | 302 → Storage public URL（现状不变） | 302 → `makeImageUrl` 计算的 raw/CDN URL；扣分/校验逻辑完全复用 |
| ZIP `POST /api/downloads/zip` | 现状不变 | 预检改用 **DB file_size**（上传时已落库）+ HEAD raw URL 确认可达 → 流式 fetch raw URL 打包；MAX 30 张 / 100MB / 并发 4 全部沿用 |
| 混合语言/混合 provider | 不可能出现（同一 language 的 images 同 provider？——**不成立**：provider 是 image 级，同 language 可混） | ZIP 支持混 provider：每文件各自按 provider 取 URL，预检/流式逻辑分支封装 |

- raw.githubusercontent.com 支持 HEAD 与流式 GET、返回 Content-Length（预检依赖）——Phase B 实施首日先做可达性实测（含 Content-Length 断言），异常则回退"GitHub 图不参与 ZIP"并在 Gate 增补记录。
- 下载扣分幂等（H2）不受 provider 影响：idempotency_key 由 Worker 生成，语义不变。

## §8 PB-7 Stage 1 迁移校验与对账策略（Owner 必答项 7）

沿用 Rev B 两阶段，补强校验与对账闭环：

1. **复制**：逐图 GET Supabase Storage（现生产仅 1 张图，天然低风险演练）→ 以原始字节 PUT GitHub（路径约定 `{asset-slug}/{lang}/{filename}`，0014 前先在 Gate 确认，见 §10）。
2. **校验（双 hash）**：
   - 计算 GitHub API 返回的 **git blob sha**（`sha1("blob {len}\0" + content)` 本地重算比对）；
   - 字节级 sha256 源/目标比对；
   - HEAD 目标 URL 确认公开可达 + Content-Length 一致。
3. **Migration Report**（`docs/v1.1/06-stage1-migration-report.md`）：每图列出 源路径/目标路径/两 hash/HEAD 结果/结论（VERIFIED|MISMATCH）。任何 MISMATCH → 重复制该图 → 重验；仍失败 → 报告 FAIL 并停在 Stage 1。
4. **对账幂等**：Stage 1 可整体重放（PUT 幂等 + 双 hash 判定），重跑不产生重复对象。
5. **Supabase 原件零删除**：Stage 1 全程不动 Storage 对象与 DB provider 字段——切换属 Stage 2，单独 Owner 授权。
6. **Stage 2 内容**（届时详设）：事务内 `update images set provider='github', storage_path=null, source_path=… where id=…`（provider CHECK 已保证互斥）→ 线上 read verification（真实浏览器三视口过图）→ 稳定窗口后才申请 Storage cleanup。

## §9 Phase B 实施清单（批准后执行）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | `0014_phase_b_github.sql` | github_write_leases + images.status（uploading/ready/failed，存量置 ready）+ 相关 RLS/grants + 审计 action 扩展（幂等超集，0013 范式） |
| 2 | Worker GitHub 客户端 | lease 抢占 → pending 行 → PUT → finalize；§5 重试矩阵；Token 仅 Worker Secret |
| 3 | Worker sweeper | scheduled handler 对账（§3） |
| 4 | 下载接线 | §7 表格；ZIP 混 provider 支持 |
| 5 | 前端接线 | Admin 上传改走 Worker（不再直传 GitHub）；Lightbox/AssetCard 切 makeImageUrl |
| 6 | 隔离库冒烟扩展 | 0014 幂等重放、lease 抢占/过期/释放、images.status 对公开视图过滤、NO-DRIFT 复验 |
| 7 | GitHub 沙盒实测 | dry-run 仓库（非生产仓库）完成 §4/§5 全矩阵 + raw HEAD 行为确认 |

完成后 **STOP → Owner 检查**，才进入 Stage 1。

## §10 留给 Owner 的开放决策（PB-1 批准时一并裁决）

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | GitHub 目标分支 | 直接提交生产分支（租约已串行）vs 独立 `images` 分支。建议：直接 main，路径 `{asset-slug}/{lang}/{filename}`，减少同步层 |
| Q2 | 租约 TTL | 建议 120s（Worker CPU 限额内上传 + 充裕缓冲） |
| Q3 | images.status 命名 | 建议 `uploading/ready/failed`；公开视图只出 ready |
| Q4 | CDN 切换口时机 | V1.1 保持 raw 默认（D4-b 既有裁决），仅留 `VITE_GITHUB_IMAGE_CDN_BASE` 空口 |
| Q5 | dry-run 仓库 | 建议单独私有/公开演练仓库，全矩阵验证后再指向生产仓库 |

## §11 非目标与 Gate 状态

- **不做**：Stage 1/2 迁移执行、生产仓库写入、生产 DB 变更、Credits 计费语义调整、R2/S3。
- **状态**: 🟡 PENDING OWNER REVIEW。批准（含 §10 Q1–Q5 裁决）后才允许 PB-1 实施清单开工。
