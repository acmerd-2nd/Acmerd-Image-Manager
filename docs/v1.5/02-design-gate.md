# V1.5 360° 产品展示 — Design Gate（Phase 0 产出）

> 日期：2026-09-09 · 依据：Owner《360度资产展示.txt》（产品规格，已冻结）+ Phase 0 开工指令（12 项必须回答）+ `docs/v1.5/01-phasing-plan.md`
> 性质：**纯审计 + 设计文档。未实施任何代码 / migration / 生产 DB / 生产仓库写入。**
> 完成后 STOP，等 Owner 批准 Phase A。

## §0 现状审计结论（Phase 0 实测）

| 机制 | 现状 | 对 360 的意义 |
| --- | --- | --- |
| GitHub 写通道 | `worker/github.ts` `ghPutFile` = Contents API（GET meta + PUT）= **2 请求/文件、1 commit/文件**；sha 校验 + 冲突重试 1 次 + 5xx 退避 ≤3 + 子请求预算 8/操作 | 360 帧直用 = **720 请求 + 360 commits**（Owner 指令 #3 指出的核心问题，见 §G3 专项评估） |
| `computeGitBlobSha` | 已实现（SubtleCrypto SHA-1，git blob 格式） | Git Data API 方案的本地 sha 预计算现成 |
| 写入租约 | `claim/release_github_lease`（Supabase RPC，resource_key + TTL 120s，跨 isolate） | 可直接复用为 `asset360:{sequence_id}` 级串行锁 |
| sweeper | cron */10，单轮 ≤10 行，uploading/failed/deleting 三态 sha 收敛 + `github.orphan.purged` 补偿删除 | 需扩展查询 360 两表（同思想，不换机制） |
| 普通图上传 | 客户端逐文件调 `POST /api/admin/images/github-upload`（1 文件 1 Worker 请求） | 360 不能照抄（144+ 张 × 2MB），见 §G2 |
| RLS 范式 | 0012/0016（admin 写 + 公开收敛视图 security_invoker）/0018（admin-only ALL 策略） | 360 读面照 0015/0021 范式；**视图加列只能末尾追加**（0021 教训） |
| 审计 allowlist | 现值 **44** 项（0018），DO 块防窄化 | 需扩 4 项 → 48（§G-A） |
| URL 出口 | `src/lib/image-source.ts` `githubRawUrl`（CDN 切换口） | 360 帧走同文件新增 helper，页面组件零拼 URL |

---

## §G1 数据模型（对应指令 #1）

**0022 迁移**（零既有表结构改动，仅新增）：

```sql
create table public.asset_360_sequences (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references public.assets(id) on delete cascade,
  frame_count  int  not null check (frame_count in (36,72,144,360)),
  status       text not null default 'draft'
               check (status in ('draft','uploading','ready','failed','deleting')),
  source_sha   text,                      -- 最终 tree/commit 校验锚（同 images.source_sha 思想）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table public.asset_360_frames (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references public.asset_360_sequences(id) on delete cascade,
  frame_index  int  not null check (frame_index >= 1),
  provider     text not null default 'github',
  source_path  text not null,             -- assets/{asset-id}/360/{sequence-id}/{frame}.png
  blob_sha     text,                      -- Git Data API blob sha（上传中登记；见 §G3）
  file_size    bigint,
  width        int, height int,
  status       text not null default 'pending'
               check (status in ('pending','uploading','ready','failed','deleting')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (sequence_id, frame_index)
);
alter table public.assets
  add column active_360_sequence_id uuid references public.asset_360_sequences(id) on delete set null;
```

**双向关系语义**（指令 #1 重点）：
- 插入：sequence 先建（draft，FK asset_id），随后 `active_360_sequence_id` 才可能指向它；`on delete set null` 保证删序列不产生悬垂引用，前台以 `active_360_sequence_id is null` = 无 360 模块
- 替换/激活：**单条 UPDATE** `assets SET active_360_sequence_id = $new`（原子，规格 §17）；DB 侧加守卫触发器（defense in depth）：active 必须指向**同 asset 且 status='ready'** 的序列，违反即拒绝
- 删除：active 序列不可直删（触发器/Worker 双重拒绝 409）；流程 = 先 `active_360_sequence_id=null`（前台即时消失）→ sequence `deleting` → GitHub 清理 → 删行
- RLS：两表 admin-only 写（ALL 策略 `is_admin()`，同 0018 范式）；读面走收敛视图（§G7）；`assets.active_360_sequence_id` 列随 assets 既有 RLS（admin 写、published_assets 视图 anon 读——**注意视图若要暴露此列只能末尾追加**，见开放决策 D1）

## §G2 上传协议（指令 #2，36/72/144/360 全规格统一）

**整组选择 → 分批上传 → 幂等收敛**：
1. Admin 选定 frame_count + 选择全部 PNG → 客户端强校验：数量精确相等（143/144 → 直接拒绝）、MIME ∈ PNG/JPEG/WebP（沿用 `GITHUB_MIME_EXT` 白名单思想）、单文件 ≤5MB、按文件名自然排序读取后**统一重编号** `frame_index 1..N`（GitHub 落盘名 `{index 补零4位}.png`，与选择时原名解耦）
2. 建序列（draft）→ **预生成全部 N 条 frame 行**（status='pending'，source_path 固定）→ 进入 uploading
3. 分批上传：每批 ≤**24 帧 / ≤50MB**（Worker 请求体限 100MB 内、子请求预算 = 批内帧数+余量），客户端可 2–3 批并发 + 进度条；每帧：GitHub blob 上传（§G3）→ `blob_sha` 回填 frame 行（status='uploading'→'ready-by-blob'）
4. 幂等/断点续传：blob 内容寻址（同内容同 sha）→ 重复上传同一帧无副作用；客户端可只传缺 `blob_sha` 的帧（complete 前任意重试/刷新续传）
5. `POST complete`：服务端校验 N 帧 blob_sha 齐全 → 组 tree → 单 commit → ref 校验（§G3）→ 全帧 status='ready' + sequence='ready'；任何不齐 → 序列 'failed'（已传 blob 留存，重试 complete 前补缺帧即可）
6. **半成品前台不可见**：公开读面只认 `sequence.status='ready' AND assets.active_360_sequence_id=sequence.id`（§G7），uploading/failed/deleting 永不进公开查询

## §G3 GitHub API 写入策略专项评估（指令 #3，本 Gate 核心）

| 维度 | 方案 A：Contents API 逐文件（现状 ghPutFile 直用） | **方案 B：Git Data API（blobs + 单 tree/commit）★推荐** |
| --- | --- | --- |
| API 请求数（144 帧） | 288（2/帧）；360 帧 = 720 | 144+4 ≈ 148；360 帧 ≈ 364（blob POST×N + head/tree/commit/ref×4） |
| **Git commit 数** | **= 帧数（144/360 个 commit）** | **1 个 commit/序列**（删除亦 1 commit） |
| 速率限制（5000/h PAT） | 720/序列，连传 2–3 套即挤占小时配额 | 364/序列，余量充足 |
| 失败恢复 | 逐帧收敛（sweeper 既有范式成熟） | blob 幂等重传；缺帧补传后 complete 幂等重建 tree；**未 commit 的孤儿 blob = GitHub 不可达对象，最终被 GC**（审计留痕 `360.upload.failed`，接受为低害残留） |
| 并发冲突 | 每文件 sha 冲突可重试（既有） | ref 更新可能 409/422（分支前移）→ 以新 head 为 `base_tree` 重建 tree 重试 ≤2（tree POST 幂等于内容） |
| 回滚/删除 | 逐文件 DELETE = 再产生 N commits | 删目录 = 1 tree(排除该目录)+1 commit；失败保留 deleting 行交 sweeper 重试 |
| 仓库历史 | 每套序列 360 commits，历史膨胀 + 网页端变慢 | 1 commit/操作，历史干净 |
| 失败窗口的可见性 | 每帧即变公开可寻址（无害，路径秘密性非安全边界） | blob 无 commit 引用前完全不可见 |
| 与既有代码关系 | 直接复用 | **新增** `ghPutBlob/ghCreateTree/ghCommitRef` 三助手（同文件、同预算/重试/审计风格），普通图上传不动 |

**结论：方案 B。** 禁止"360 张 = 360 commits"（Owner 指令）。普通图片继续走 Contents API（数量小、逐帧 sweeper 收敛成熟，不动）。两个方案的存在本身就是决策记录；方案 B 的失败窗口（孤儿 blob）以审计 + GitHub GC 承接，不做主动清理（Contents API 删不可达对象无从下手）。

**H3 一致性证明路径（指令 #4）**：blob sha 本地预计算 = 服务端登记 `blob_sha` → complete 后 `GET meta` 抽验帧 sha === 登记值 → sequence ready；崩溃窗口（ref 已更新/DB 未 ready）由 360 版 sweeper 以 sha 对比收敛（同 images 语义）；DB 有行远端无 blob → complete 拒绝 + failed；远端有 blob DB 无行 → 孤儿 blob（无害残留）。沙箱需注入：SHA 不匹配、缺帧、ref 冲突、complete 重复调用（幂等）四类负样本。

## §G4 前台产品形态（指令 #5）

一个组件 `SpinViewer`；前台文案只有 `360° View` / `Loading 360° View…` / `左右拖动查看 360°`；Admin 才见 Frames 数与 Basic/Standard/High/Ultra 轻提示。frame_count 绝不出现在任何用户端 DOM/i18n 文案。

## §G5 解耦（指令 #6）

360 与 Language（语言 Tab 切换不重挂载/不重取）、普通 Gallery（独立模块，Gallery 在其后）、Single/ZIP/Package Download（**零代码触碰**：ZIP 仍按 asset_language 图片打包，Package 仍走网盘源，二者查询不含 360 表——Phase D 用回归证明）、Credits（无任何扣分调用）。硬规则：Phase B/C 的 diff 中不得出现 downloads/credits 相关文件改动。

## §G6 读面与状态（指令 #7）

收敛视图 `published_360`（security_invoker，0015/0021 范式）：
`assets(status='published') ⋈ active_360_sequence_id = sequences(id, status='ready')` → 输出 `asset_id, sequence_id, frame_count, frames jsonb`（frames = `[{index, source_path}]` 按 frame_index 排序聚合）。一次查询供整个 Viewer（360 条路径 ≈ 30KB）。uploading/failed/deleting/pending 结构性不可达（视图 where 关死）。admin 列序列清单直查基表（is_admin RLS）。

## §G7 性能方案（指令 #8）

首帧优先（frame 1 加载成功才可交互，Viewer 容器不阻塞页面首屏，异步挂载）→ 方向感知邻帧预载（当前帧 ±8，拖动方向加权）→ `Map<index, HTMLImageElement>` LRU 上限 **24**（实测后可调 16–32）→ 内存上界 ≈ 24×5MB=120MB 最坏、常规 24×1MB=24MB（Gate 建议后台上传时对帧做 ≤2048px 长边建议提示，非强制）；`loading=lazy` 不适用（程序化加载），用 Image() 预载队列；页面卸载/组件卸载清空缓存。

## §G8 移动端（指令 #9）

Pointer Events + `touch-action: pan-y`（浏览器原生保证纵向滚动优先）；手势开始后 `abs(dx)>abs(dy)` 判定进入旋转并 `setPointerCapture`；反向（横向幅值不足）直接放行滚动。真机验收进 Phase D 矩阵。

## §G9 Replace/Activate/Remove 原子语义（指令 #10）

- **Activate/Replace 激活**：`UPDATE assets SET active_360_sequence_id=$new WHERE id=$asset` 单语句 + 守卫触发器（新序列必须同 asset + ready）。替换流程：新序列独立上传 ready → 激活切指针 → 旧序列保留（可手动 Remove）
- **Remove**：`active_360_sequence_id=NULL`（单语句，前台即时消失，无中间错误态）→ sequence `deleting` → GitHub 删目录（方案 B 单 commit）→ 删行；任一步失败保留 deleting 行交 sweeper
- **不存在"删除中前台报错"窗口**：前台查询以 active join ready 收敛，任何指针变化都是原子的

## §G10 存储路径（指令 #11）

`assets/{asset-id}/360/{sequence-id}/{frame-index 4位补零}.png` —— UUID，禁 slug；多版本序列天然隔离；路径在 frame 行创建时固化，重命名/替换不影响 identity。

## §G11 积分/下载解耦（指令 #12）

360 = 纯预览：0 积分、无单帧下载 UI、ZIP 打包查询不 join 360 表、Package 不含 360。**本功能 diff 中 downloads/credits 文件改动数必须为 0**（Phase D 红线 grep 验证）。

## §G12 审计与 allowlist

新增动作（44→48，幂等 DO 块 + 防窄化守卫）：`360.sequence.created` / `360.sequence.activated` / `360.sequence.deleted` / `360.upload.failed`。浏览 360 不记审计（规格 §48）。admin 上传/激活/删除全落 `writeAudit`（actor_id=auth.uid()，target=sequence/asset）。

---

## 开放决策清单（Owner 裁决后才进 Phase A）

| # | 决策点 | Agent 建议 |
| --- | --- | --- |
| D1 | `published_assets` 是否也暴露 `active_360_sequence_id`（资产卡可标"360 可看"角标） | **暂不**——本期只做详情页；卡片角标留 backlog（避免再动公开视图） |
| D2 | 方案 B 确认（§G3） | 确认采用 Git Data API |
| D3 | 批次参数：每批帧数 / 单文件上限 | 24 帧 / 50MB 每批；单文件 ≤5MB；总大小不设限（客户端校验） |
| D4 | 守卫触发器（active 必须指向同 asset ready 序列） | 加（Worker 之外的双保险，成本极低） |
| D5 | 孤儿 blob（上传放弃/failed）处理 | 接受 GitHub GC + 审计留痕，不做主动清理 |
| D6 | 帧规格建议提示 | Admin 上传时提示"建议 ≤2048px、≤5MB/帧"，不强制 |

## 阶段映射确认

Gate 批准 → **Phase A**（0022 迁移 + RLS + allowlist + 视图 + 隔离冒烟）→ STOP 授权 → **Phase B1/B2**（Worker 端点 + Admin UI，方案 B 实施 + 沙箱负样本注入）→ STOP 授权 → **Phase C**（SpinViewer + 读面接入）→ STOP 授权 → **Phase D**（验收矩阵 + 性能 + 收口）。

**纪律声明**：本 Gate 未动任何生产资源；Phase 0 全程只读审计 + 本文档。
