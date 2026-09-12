# V1.9.0 — 体验 / 性能 / UI·UX 优化方案（体检报告）

- 日期：2026-09-11（Asia/Shanghai）
- 方法：线上生产站实测（image.acmerd.com，桌面）+ 全量代码静态审查（前端 SPA + Hono Worker + 关键迁移）双路结合。
- 目标：不改变现有技术栈（React 18 / Vite / Tailwind / Cloudflare Worker / Supabase / GitHub 图床）前提下，产出一份按「影响 ÷ 工作量」排序、可逐项拍板的优化 backlog。
- 范围授权：含中低风险性能优化（代码分割 / 图片懒加载与缩略 / 列表批量化等），但尽量控制依赖膨胀。
- 状态：本文件仅为方案，**未改动任何代码**。

---

## 0. 一句话结论

这是一个功能完整、工程质量在线上的图库站；最大问题不在功能，而在**首屏图片负载**与**移动端可访问性**：网格卡片直接拉全分辨率原图（实测平均 **~1.12 MB/张**，单页最多 20+ 张），加上**每张卡各发一次封面查询**（实测单页 **14 次** Supabase 往返），共同把暖启动 FCP 拖到 **~2.26s**；同时**移动端没有任何导航入口**，手机用户点不到「搜索/排期/登录」。修掉前两项 + 补上移动导航，是本期投入产出比最高的组合。

---

## 1. 线上实测快照（2026-09，桌面，缓存较暖）

| 指标 | 实测值 | 说明 |
|---|---|---|
| FCP（首屏） | **~2260 ms** | 即便资源命中缓存仍 >2s，说明瓶颈在数据/图片而非下载 |
| DOMContentLoaded | ~1803 ms | |
| load | ~2266 ms | |
| JS 传输 | ~162 kB（主包 153 kB） | 主包 gzip 已不小，且含两套语言词典 |
| 单浏览页 Supabase 请求数 | **14** | 封面 N+1 + settings 重复读 |
| GitHub 原图请求 | 7（首屏可见） | **全部为全分辨率原图**，无缩略变体 |
| 抽样原图大小 | 980KB / 896KB / **1985KB** / 1082KB / 1010KB / 786KB | 合计 6.7MB / 6 张，**平均 ~1.12MB/张** |
| `<img>` width/height 属性 | **0** | 全站点几乎无尺寸声明 → CLS 风险 |
| `<img>` loading=lazy | 6/7 | 详情页网格与 Lightbox 主图缺懒加载 |
| `<html lang>` | **"en"** | 但默认 UI 为 zh-CN → SEO / 读屏错配（仅在切换语言后才纠正） |
| 控制台错误 | 0 | 干净，无运行时报错 |
| 移动端 | 无汉堡菜单，主导航 `hidden sm:flex` 整体隐藏 | 手机不可达「搜索/排期/个人资料/登录」 |
| favicon / per-route 标题 | 缺失 / 仅全局品牌标题 | |

---

## 2. 优先级总览（P0 = 本期强烈建议）

> 打分：Impact=用户可感知影响；Effort=S/M/L；Risk=回归风险。

| # | 项 | 维度 | Impact | Effort | Risk | 优先级 |
|---|---|---|---|---|---|---|
| P0-1 | 图片缩略变体（Worker 图片代理 + CF 图像缩放/回退） | 性能 | 极高 | M | 中 | P0 |
| P0-2 | 封面批量/视图化，消除每卡一次查询 | 性能 | 高 | S–M | 低 | P0 |
| P0-3 | 移动端导航（底部标签栏或汉堡抽屉） | UX | 高 | M | 低 | P0 |
| P0-4 | 首页搜索改 `navigate()`（去掉整页刷新） | 性能/UX | 中高 | S | 低 | P0 |
| P0-5 | 主包瘦身：懒加载非默认语言词典 + vendor manualChunks + 懒挂 auth/error 页 | 性能 | 中 | S–M | 低 | P0 |
| P1-1 | 静态资源缓存头（`/assets/*` immutable）+ GitHub 图 URL 固定 commit SHA | 性能 | 中 | S | 低 | P1 |
| P1-2 | 硬编码字符串接入 i18n（含 aria-label、状态徽标、对话框按钮） | UI/无障碍 | 中 | S | 低 | P1 |
| P1-3 | 深色模式对比度令牌（新增 `--success`，调 `.dark` destructive） | UI/无障碍 | 中 | S–M | 低 | P1 |
| P1-4 | 对话框可访问性（焦点陷阱 + Esc + autofocus + aria-modal，抽 `useFocusTrap`） | 无障碍 | 中 | M | 低 | P1 |
| P1-5 | 统一反馈通道（Profile/Editor 内联横幅 → Toast；原生 `confirm` → ConfirmDialog） | UX | 中 | M | 低 | P1 |
| P1-6 | Context value 用 `useMemo`/`useCallback`（AuthProvider/Theme） | 性能 | 中 | S | 低 | P1 |
| P1-7 | 错误/空态可返回/重试（详情页、搜索页对齐首页） | UX | 中 | S | 低 | P1 |
| P2-1 | 管理端变更乐观更新 + 局部刷新（排序/设封面不整页 refetch+置灰） | UX | 中 | M | 中 | P2 |
| P2-2 | `<img>` width/height/decoding + Lightbox 预加载相邻原图 | 性能/UX | 低中 | S | 低 | P2 |
| P2-3 | 详情页/网格统一骨架屏；语言标签用 tablist 语义 | UI/无障碍 | 低中 | S | 低 | P2 |
| P2-4 | 日期按 UI 语言格式化；`<html lang>` 挂载即同步 | UI/无障碍 | 低 | S | 低 | P2 |
| P2-5 | favicon + 每路由 document.title | SEO/UX | 低 | S | 低 | P2 |
| P2-6 | `prefers-reduced-motion` 尊重 + 关键动作用 `aria-live` 播报 | 无障碍 | 低 | S | 低 | P2 |
| P2-7 | Worker 下载热路径：JWKS 本地验签 + 合并 role/settings/cost 为一次 RPC | 性能 | 中(下载量级) | M | 中 | P2 |
| P2-8 | 后台用户行操作菜单键盘化（role=menu/aria-expanded/Esc/方向键） | 无障碍 | 低 | M | 低 | P2 |

---

## 3. 性能（详）

### P0-1 图片缩略变体 ★最高影响

- 现状/证据：`src/features/assets/api.ts:200-208`（`imageSrcOf`）对 `provider='github'` 直接返回全图 `raw.githubusercontent.com` 原图（`src/lib/image-source.ts:40-45`），缩略变体 `THUMB_*` 只对 supabase provider 生效；全站 `<img>` 无 `srcset/sizes`。实测网格单张 0.8–2.0 MB，平均 1.12 MB。
- 建议（推荐路线，中低风险）：在既有 Worker（`image.acmerd.com` 已在 Cloudflare 上）加一个只读图片代理端点 `GET /api/img/{repoPath}?w=480&q=72`，用 **Cloudflare Image Resizing** 绑定（或回退：仅透传 + 强缓存 + 设置正确 `width/height`），把网格/封面 URL 从「GitHub 原图」切到「Worker 缩放图」。URL 生成点已有接缝：`image-source.ts:20` 的 `VITE_GITHUB_IMAGE_CDN_BASE`。
  - 前端只需把卡片 `<img src>` 从原图改成 `?w=显示宽*dpr` 的缩放 URL；详情页/Lightbox 再按需请求原图。
  - 兜底：若暂不启用 CF 图像缩放，先做 **width/height + lazy + 详情页原图懒加载**，避免最坏 CLS 与首屏并发。
- 影响：单页传输从 ~25MB 级降到 ~1–2MB 级，直接压 LCP/带宽/移动端体验。Effort M / Risk 中（需图片代理 + 缓存 + 尺寸参数校验）。

### P0-2 封面查询批量化

- 现状/证据：`src/features/assets/AssetCard.tsx:13-23`、`src/features/collections/CollectionCard.tsx:28-31` 每卡在 `useEffect` 里 `getCoverUrls([单id])`（`assets/api.ts:247-259`）→ 一次浏览页 N 次 `images` 查询。实测单页 14 次 Supabase 往返。后台 `AdminAssetsPage.tsx:43` 已是批量正确范式。
- 建议：把封面 `provider/storage_path/source_path` 直接并入 `published_assets` 视图（迁移 `0001:200-218` 已暴露 `cover_image_id`），前端渲染卡时无需再查询；或页面级收集 ids 一次性批量。
- Effort S–M / Risk 低（视图列新增 + 类型同步，仿 V1.7.0 `published_collections` 收口做法）。

### P0-3 移动端导航

- 现状/证据：`AppShell.tsx:64` 主导航 `hidden … sm:flex`，全站无汉堡（实测 `mobileMenuButtonPresent:false`）。手机用户无法进入 搜索/排期/个人资料/登录/退出。后台 `AdminLayout.tsx` 有兜底 pill，但前台没有。
- 建议：前台加移动端底部标签栏（探索/搜索/排期/我的）或头部抽屉（`Menu` 图标 + 侧滑）。保持 i18n + aria-current。
- Effort M / Risk 低。属功能性硬缺口，建议 P0。

### P0-4 首页搜索去整页刷新

- 现状/证据：`HomePage.tsx:87` `window.location.assign('/search?q=')` → 丢弃 SPA、重下主包、重跑鉴权与全部查询。
- 建议：改 `useNavigate()`（SearchPage 本身已 URL 同步，体验良好）。一行级改动。Effort S / Risk 低。

### P0-5 主包瘦身

- 现状/证据：`src/i18n/index.tsx:2-3` 静态 import `zh`+`en`（实测两词典都进了 506 kB 主包）；`src/App.tsx:7-11`  eager import Login/Register/Reset/ResetConfirm/ErrorPages；`vite.config.ts` 无 `build`（无 manualChunks）。默认 zh-CN，`en` 对多数首访是死重。
- 建议：非默认词典动态 `import()`；5 个 eager 页改 `lazy()`；vendor `manualChunks`（react / react-dom / router / supabase 分离，业务代码更新不再让用户重下厂商包）。Effort S–M / Risk 低。

### P1-1 缓存与不可变 URL

- 现状/证据：`wrangler.toml [assets]` 无 `cacheControl`/immutable；GitHub 图用 `main` 分支路径，`raw.githubusercontent` 分支 URL 只缓存 ~60s。
- 建议：加 `_headers`：`/assets/*` `public,max-age=31536000,immutable`，`index.html` `no-cache`；图片 URL 固定到 **commit SHA**（`worker/github.ts` 已能取 head commit）→ 变不可变、可长缓存。Effort S / Risk 低。

### P1-6 Context value memoization
- `AuthProvider.tsx:111-124`、`theme.tsx:52` 每次 render 新建 value 对象 + 闭包 → 会话/主题变更触发 AppShell 子树整体重渲染。`useMemo` value + `useCallback` handler。Effort S / Risk 低。

### P2-7 Worker 下载热路径（量大再做）
- `worker/index.ts:103-124,310,340,342` 单次下载前 ≥5 段串行 Supabase 往返，`site_settings` 每请求重读。建议：JWKS 本地验签省一次 `/auth/v1/user`、role+disabled+cost 合一次 RPC、settings Worker 内存 30–60s 缓存。Effort M / Risk 中（鉴权语义）。

---

## 4. UX（交互流程）

- P0-3 移动导航（见上）。
- **P1-5 反馈通道统一**：admin=Toast、Profile=内联 `<p>`、Editor=绿色横幅、移除头像=原生 `window.confirm`（`ProfilePage.tsx:72`）→ 全站收敛到 `ToastProvider` + `ConfirmDialog`。Effort M / Risk 低。
- **P1-7 错误/空态可返回/重试**：资源未找到无返回 CTA（`AssetDetailPage.tsx:234,570-578`）、搜索错误仅一行裸文本无重试（`SearchPage.tsx:125`），而首页有重试（`HomePage.tsx:114-134`）→ 不一致，补齐。Effort S / Risk 低。
- **P2-1 管理端乐观更新**：`run()`（`AdminAssetEditorPage.tsx:136-146`）每次变更全局置灰 + 整表 refetch；排序/设封面应先乐观更新本地态、失败回滚 + toast。Effort M / Risk 中。
- 正向：下载前 credits 成本展示已做对（`AssetDetailPage.tsx:487-491`）；Spin360 键盘+重试+错误态堪称范本。

---

## 5. UI / 视觉一致性

- **P1-2 硬编码字符串接入 i18n（含 aria-label）**：`AssetDetailPage.tsx:456-458,495`（`Select/Deselect/Preview ${filename}/Download image`）、`ToastProvider.tsx:73`（Dismiss）、`AdminLayout.tsx:28`（Admin Console）、`AdminAssetEditorPage.tsx:159`（"Back to Assets"）、`:395`（"Restore"）、`:651-653`（Delete 对话框标题/按钮）、`StatusBadge` 的 `Draft/Published/Archived`（`:662-669`）与已 i18n 的 `STATUS_BADGE`（`AdminAssetsPage.tsx:18-22`）重复且冲突、`RegisterPage.tsx:107-108`（标题复用为描述）。纯 label 替换，~15 处。Effort S / Risk 低。**读屏/双语用户当前会听到英文。**
- **P1-3 深色模式对比度**：无 `--success` 令牌，成功色硬编码 `text-green-600/700 on bg-green-600/10`（`AdminAssetEditorPage.tsx:409,552`、`AdminPackageCard.tsx:142`、`ProfilePage.tsx:189,224`）在深色下偏糊；`.dark` 的 `--destructive` `0 62% 40%`（`index.css:41`）配 `text-sm` 约 3:1 偏低。建议新增 `--success` 令牌并在 `.dark` 调亮 destructive。Effort S–M / Risk 低。
- **P2-2 卡片封面 pop-in**：`AssetCard.tsx:38` 用 🖼️ emoji、`CollectionCard.tsx:51` 用 FolderOpen 图标，兜底风格不一致；异步取封面期间纯 `bg-muted` 无微光。建议统一兜底图形 + 与列表同款 `CardSkeleton`。
- **P2-3/P2-4**：详情页加载用裸 `Spinner`（`AssetDetailPage.tsx:236-241`）与全站骨架屏不一致；语言切换标签 `:360-391` 是普通按钮，无 `role=tablist/tab/aria-selected`；`AdminAssetsPage.tsx:161` 用浏览器本地 `toLocaleString()`、`SchedulePage.tsx:76` 直接 `YYYY-MM-DD`，未随 UI 语言。

---

## 6. 无障碍（a11y）

- **P1-4 对话框焦点管理（最大簇）**：`ConfirmDialog.tsx:27-48` 无 autofocus/焦点陷阱/Esc/`aria-labelledby`，却用于永久删除；`AvatarCropperDialog.tsx:102` 连 `role="dialog"/aria-modal` 都没有；`CreditsAdjustDialog`/`UserNotesDialog`/`AdminCollectionsPage` 同理。仅 Lightbox 做了焦点保存/恢复但缺 Tab 陷阱。建议抽一个 `useFocusTrap(ref,{onClose})` 通用复用。Effort M / Risk 低。**高价值快赢。**
- **P2-4 `<html lang>` 首屏错配**：`index.html:2` 为 `en`，默认 UI zh-CN，只在切换时同步（`i18n/index.tsx:87-90`）。LocaleProvider 挂载 effect 里设一次即可。3 行。**实测已确认 lang="en"。**
- **P2-6 reduced-motion / aria-live**：全站无 `prefers-reduced-motion`（骨架 `animate-pulse`、`animate-spin`、Spin360 自动转、`HomePage.tsx:68` 平滑滚动）；除 toast 外无 `aria-live`，Profile 保存 / Lightbox 翻页对读屏静默。
- **A4 焦点环 + 触控目标**：Apple 开关（`ThemeToggle.tsx:30-33`、`LocaleSwitch.tsx:33-36`）无 `focus-visible:ring`（与 `ui/switch.tsx` 不一致）；重排按钮 `h-7 px-1.5` 命中区 <44px 且仅 `title`、无 `aria-label`。role/aria-checked 均正确。
- **P2-8 后台用户行菜单**（`AdminUsersPage.tsx:378-470`）：无 `role=menu/menuitem`、无 `aria-expanded`、仅外部点击关闭、无 Esc/方向键。
- 正向：登录/注册/资料 表单 label + autoComplete 规范；NavLink 自带 `aria-current`；Spin360 键盘可达。

---

## 7. V1.9.0 建议切片（若一次性开工，建议范围）

优先「极高影响 / 低-中风险」，控制在一次可交付、可回滚的窗口：

1. 性能包：P0-2（封面批量化/视图列）+ P0-3（移动导航）+ P0-4（搜索 navigate）+ P0-5（主包瘦身）+ P1-1（缓存头 + SHA URL）。
2. 性能旗舰：P0-1（图片缩略，走 `/api/img` Worker 代理 + Cloudflare 图像缩放；先做 width/height/lazy 兜底再上缩放）。
3. 一致性/无障碍快赢包：P1-2（i18n 硬编码）+ P1-4（`useFocusTrap`）+ P1-3（`--success`/dark 对比）+ P2-4（html lang）。

暂缓（收益/风险比低或需更大动作）：P2-1 乐观更新、P2-7 Worker 验签改造、P2-8 菜单键盘化——留 V1.9.x。

---

## 8. 验收与风险策略（逐项）

- 每项遵循既定纪律：实现 → 本地验证（typecheck+build+浏览器/脚本）→ commit → **停下等部署授权** → 部署（+ push 单独授权）。
- 性能项给「量化前后对比」：以本文件第 1 节实测为 baseline，改后复测 FCP / 单页图片传输 KB / Supabase 请求数 / Lighthouse（可移动端 4G 节流）作为验收。
- P0-1 图片代理：需新增只读端点 + 尺寸/格式白名单 + 缓存头，避免成为开放代理（仅允许本图床仓库路径前缀）。
- 视图/类型改动（P0-2）：仿 V1.7.0 `published_collections` 列新增收口法（重建视图列序 + `database.ts` 同步）。
- **部署前置**：Cloudflare 部署 Token 缺 `Zone:Read` / `User Details:Read`（已记备忘，每次 deploy 后打非致命 routes 列表告警）。本期若要新增 Worker 路由/绑定（P0-1、P2-7 可能需 images binding），建议**先补齐 Token 权限**以免真卡发布。
- 深色模式令牌改动需回归：亮/暗两态对比度自查（尤其 success/destructive 文本）。

---

## 9. Top-5 快赢（最低风险最高性价比，可先行）

1. P0-4 搜索 `navigate()`（1 行，去整页刷新）。
2. P0-2 封面并入视图/批量（去 14→~3 次往返）。
3. P1-2 硬编码字符串/aria-label 接 i18n（纯替换）。
4. P2-4 `<html lang>` 挂载同步（3 行）。
5. P1-4 `useFocusTrap` 复用到所有对话框（1 个 hook）。

（其中 P0-1 图片缩略是「旗舰级」收益，但工作量与风险高于以上 5 项，单列推进。）
