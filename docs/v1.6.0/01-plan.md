# V1.6.0 优化 — 分阶段计划与决策

版本：v1.6.0（Owner 提出两项前台/后台体验优化）
日期：2026-09-10
流程：实现 → 验证 → 提交 → STOP → Owner 授权 → 部署

## 需求（Owner 原话）
1. 后台还没有填写网盘链接的地方。
2. 前台点击图片看大图时无法直接看下一张，得先关掉再点下一张，不直觉。

## Owner 决策（本轮 AskUserQuestion）
- 网盘 provider：**只做现有 quark + 百度**（不改枚举/白名单，零迁移）。
- 前台可见性：**维持现状**——登录用户才拉得到链接、下载扣积分（不放开学 0001 select 策略）。
- Lightbox：**按钮 + 键盘 ←/→ + 计数器 + 末张回环 + 触摸左右滑动**（原生实现，无新依赖）。
- 节奏：**两项各一阶段 A/B，分别 STOP 授权**。

## Phase A — 后台网盘链接写入
- 现状：`public.download_sources`（asset 级，unique(asset_id,provider)，enum download_provider quark|baidu）+ RLS（admin ins/upd/del、select=is_admin 或 登录且 enabled 且 asset published）+ 0004 URL 守卫触发器 + download_source.updated 审计 + 前台 PackageDownloadPanel + Worker /api/downloads/package 扣分跳转，**全部早已就绪**；唯一缺的是后台没有写入入口。
- 改动：
  - `src/features/downloads/api.ts` 增 admin CRUD：`listDownloadSourcesAdmin` / `saveDownloadSource`(upsert onConflict `asset_id,provider`) / `deleteDownloadSource`，`DOWNLOAD_URL_INVALID` 映射为 `DownloadSourceError('invalid_url')`。
  - `src/features/downloads/AdminPackageCard.tsx`（新）：quark/百度两行，URL 输入 + 启用勾选 + 保存 / 移除（含二次确认）；前端 `isSafePackageUrl` 预校验、后端 0004 终审，错误本地化。
  - `AdminAssetEditorPage` 于 360 卡后挂载该卡。
  - i18n `admin.packageCard.*`（zh/en 同构）。
- 零迁移、零 Worker 改动。
- 验证：`scripts/v16-a-package-admin-verify.mjs`（admin JWT 经 PostgREST，隔离 draft 资产，finally 级联清零）—— 合法写入/更新/停用/删除 + 四类非法 URL 被拒 + 审计增量 + 零残留。

## Phase B — 前台 Lightbox 翻页
- 现状：`src/components/Lightbox.tsx` 仅收单图，无 prev/next；唯一调用点 `AssetDetailPage`（传 `preview` 单对象）；无灯箱库。
- 改动：
  - Lightbox 改收 `images: ImageRow[]` + `index`（+ 可选 `onIndexChange`），内部环形索引；新增左右翻页按钮（ChevronLeft/Right）+ 键盘 ←/→/Esc + 「第 x / 共 n」计数器；`n<=1` 自动隐藏翻页；`touch-pan-y` + pointer 位移阈值做触摸滑动；组件内 i18n 化（复用已有 `asset.previewClose`/`asset.previewDownload`，新增 `previewPrev`/`previewNext`/`previewCount`）。
  - `AssetDetailPage`：`preview` 由「单图」改为「当前语言列表 + 索引」，打开时按 id 定位索引；下载仍走 `onSingleDownload`。用索引而非对象避免跨语言串图。
- 零迁移、零 Worker 改动。
- 验证：typecheck + build + 浏览器实走（大图内 ←/→ 切换、计数、回环、触摸、焦点回归、切语言大图组不串图）。

## 部署口径
本版纯前端：部署 = `vite build` + `wrangler deploy`（Worker 仅托管静态资源，未改代码）。A、B 各自收口后按阶段授权。
