# V1.5 360° Product Viewer — Phase B/C/D 实施与验收报告

版本：V1.5 收口稿（Phase D 部分项待 0023 授权后补跑）
日期：2026-09-10
关联：`01-phasing-plan.md`（阶段与 STOP 点）、`02-design-gate.md`（§G1–G12 裁决、D1–D6 决策）
生产：Worker ver `1c9b8281`(B1) → B2/C 之后为当前线上版本；前端入口 chunk `index-EquUwtrk.js`
远端：`main = c8432a9`（28d30d4 B1 → 3105bb8 B2 → c8432a9 C）

---

## 1. 交付清单

| 阶段 | 产物 | 状态 |
| --- | --- | --- |
| A | `0022` 数据模型（序列/帧/active FK + 守卫触发器 + RLS + `published_360` + allowlist 44→48） | ✅ 已应用生产，冒烟 16/16 |
| B1 | `worker/github.ts` Git Data API（blob/tree/commit/ref 单提交 + 目录删除）；`worker/index.ts` 7 个 admin 端点 + 360 sweeper | ✅ 已部署，沙箱 36/36、线上 15/15 |
| B2 | `src/features/assets360/{api,Spin360,Admin360Card}`、`make360FrameUrl`、类型层镜像、编辑器接入、删资产先清 360 | ✅ 已部署 |
| C | `AssetDetailPage` 前台 360° View（Gallery 之前、语言解耦、无 active 零渲染） | ✅ 已部署 |
| D | 验收矩阵脚本 `v15-d-acceptance.mjs`、夹具脚本 `v15-c-e2e-{setup,teardown}.mjs`、素材生成器 `tools/gen-360-frames.mjs` | 🟡 后端矩阵待 0023 |

---

## 2. 生产实走发现（本地沙箱测不出来的三类）

### 2.1 帧上传串行过慢 → 已修（B2 内）
逐帧串行打 GitHub：36 帧实测 89.4s + 22.7s = **112s**（≈3.1s/帧），360 帧外推 ≈20 分钟，不可接受。
改为批内 4 路并发池后：**36 帧 8.5s**（生产复测），≈0.24s/帧，360 帧外推 ≈1.4 分钟。

### 2.2 GitHub 抖动导致半截序列无法续传 → 已修（B2 内）
真实网络抖动使 1 帧 `blob POST failed: Network connection lost`，序列停在「上传中 35/36」。
补两层：客户端只重传失败帧（≤3 轮，去重）；行级「补传缺失帧」入口（刷新后草稿丢失仍可续传）。

### 2.3 Cloudflare 子请求配额打爆 → 修复待授权（0023）
Phase D 四规格矩阵跑到首批 24 帧即失败：

```
blob POST failed: Error: Too many subrequests by single Worker invocation
```

根因（算术吻合）：本账户单次调用子请求配额 **50**；传帧端点原先「每帧 1 次 GitHub blob POST + 1 次 PostgREST PATCH」，
24 帧 = 48 子请求 + 租约/取帧/序列状态 ≈ 5 个 → 恰好在第 24 帧撞墙。
**B1 沙箱未暴露，因为本地 workerd 不演算该配额**（教训：涉及子请求预算的改动必须至少在生产跑一次冒烟）。

修复（已入库待部署）：
- `0023_v15_d_frames_bulk_update.sql`：新增 `update_asset_360_frames(jsonb)` 批量登记 RPC，
  仅 `service_role` 可执行、`security definer`，并用谓词限定「只允许改写 draft/uploading/failed 序列的帧」+ sha 格式校验，
  杜绝篡改线上 ready 序列。
- 传帧端点：blob 循环内只收集登记项，循环后 **1 次 RPC** 落库；RPC 失败整批 `retry_later`（内容寻址，重发幂等）。
- 每请求帧数上限 24 → **20**（20 帧/批 ≈ 25 子请求，留一倍余量），前端分批同步。

---

## 3. 验收矩阵（规格 §53）

### 3.1 Admin 面

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 数量错误拒绝 | ✅ | 界面「需要 36 张图片，当前只有 35 张」且零写请求 |
| 非 PNG 拒绝 | ✅ | `N1a Unsupported type` 逐帧回执，批内不中断 |
| 单帧体积上限 | ✅ | `N1b File too large`（>5MB） |
| 越界帧号 | ✅ | `N1c frame_index out of range` |
| 批量上限 | ✅ | `N3` 21 帧/请求 → 400 |
| 36 上传 | ✅ | 生产夹具 36 帧 8.5s → 单 commit `2608933` |
| 72 / 144 / 360 上传 | ⏳ | 待 0023 部署后 `v15-d-acceptance.mjs` 全量补跑 |
| Preview | ✅ | 预览 overlay 内真实播放器，拖拽 0001→0031（180px/6px 精确） |
| Activate | ✅ | 指针落库 + 审计 `360.sequence.activated` |
| Replace（旧版保留可回滚） | ✅ | 原子切换后旧序列仍 ready，再单 commit 清理（`removed_remote_files` 精确） |
| Remove | ✅ | 指针先 null → 远端 36 帧清空 → 行清零 → 审计 `remote_removed:36` |
| 审计四动作 | ✅ | created(draft/complete 两阶段)、activated、deleted、upload.failed(sweeper) |

### 3.2 User 面

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 360° View 显示 | ✅ | 真实已发布资产页，区块在 Gallery 之前 |
| 鼠标拖动 | ✅ | 180px → +30 帧（6px/帧） |
| 触屏横滑 | ✅ | touch 指针 150px → `0002→0027` |
| 纵向不误触旋转 | ✅ | 同距离纵向仅 +1 帧（邻帧收敛），非 26 帧；`touch-action: pan-y` |
| 键盘 ←→ | ✅ | 3 次 `→` → `0031→0034` |
| Auto Rotate | ✅ | 0008→0017 持续推进，默认关 |
| Fullscreen / Esc | ✅ | 真实点击进入/退出，按钮文案翻转「退出全屏」 |
| 点帧不进 Lightbox | ✅ | 帧点击后无 `[role=dialog]`，播放器仍在 |
| 五语言切换 360 不变 | ✅ | EN→DE→IT→FR→ES→EN：同一 DOM 节点探针存活、画面冻结 `0028`、URL lang 在变 |
| 无 360 → 零渲染 | ✅ | 真实资产 ED60W（9 图）无区块、无虚线空盒 |

### 3.3 规格语义 / 下载隔离 / 性能

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 36/72/144/360 前台都是「360° View」 | ✅ | 前台文案零帧数（正则断言无 `36 frames` 类字样） |
| 360 不扣积分 | ✅ | 全程操作前后 `credit_accounts.balance` 不变 |
| 单帧不可下载 | ✅ | 帧 id 打 `/api/downloads/image/:id` 非 200 |
| ZIP / Package 不含 360 | ✅ | 帧存独立表；夹具语言下 `images` 0 行 |
| 首帧优先 | ✅ | 首个帧请求即 `0001.png` |
| 不一次加载全部 | ✅ | 初始帧请求 **17** = 首帧 + 预载窗（±8），远小于 36 |
| 缓存有上限 | ✅ | 转完一圈 DOM 恒为 **1 个 `<img>`**，堆内存 21MB 不涨 |
| 首屏不被 Viewer 阻塞 | ✅ | `published_360` 775ms、帧 fetch 861ms 均为异步，DCL 2296ms |

---

## 4. 遗留与风险

1. **大陆首帧冷启动 ~8s**：`raw.githubusercontent.com` 冷连接实测首帧 `responseEnd` 距导航起点 ≈8.0s（暖连接仅 0.86s）。
   这是 Gate R1 已知风险的量化体现；缓解通道已预留 —— 配置 `VITE_GITHUB_IMAGE_CDN_BASE` 即整体切 CDN，数据与组件零改动。建议 V1.5 上线后尽快评估。
2. **行级补传要求重选同一批完整文件**（帧序号按文件名顺序对齐）；只选缺帧会给出明确报错而非错序写入。
3. **子请求配额是隐性天花板**：任何「每帧一次数据库写」的新端点都会重演 2.3。后续若加多帧批量操作，一律走合并 RPC。
4. 移动端仅做了指针级手势与轴分离验证，**未做真机实测**（iOS Safari 的 fullscreen 行为差异需人工确认）。

---

## 5. 复跑方式

```bash
node scripts/tools/gen-360-frames.mjs .scratch/360-frames-360 360   # 素材
node scripts/v15-b1-prod-verify.mjs                                 # 端点与守卫（零 GitHub 写入）
node scripts/v15-d-acceptance.mjs                                   # 后端验收矩阵（真实写入，自动清理）
WORKER_BASE=https://image.acmerd.com node scripts/v15-c-e2e-setup.mjs      # 五语言前台夹具
WORKER_BASE=https://image.acmerd.com node scripts/v15-c-e2e-teardown.mjs   # 夹具拆除 + 零残留核对
```
