# Phase 9 · UX & Performance — Design Gate（PENDING OWNER REVIEW）

> 文档性质：**设计门禁**（Design-first，本文件获批前不写任何实现代码）
> 编制：主理人（Agent） · 日期：2026-09-03
> 依据：`【分阶段】acmerdImage-manager.md` Phase 9/9.1/9.2 + Gate G9；`【总纲】acmerdImage-manager.md` Phase 9；Phase 8 Security Review（安全基线）
> 前置：Phase 8 CLOSED（G8 PASS，commit `74cae3a`），生产已应用 0001–0007

---

## 1. 定位与范围红线

Phase 8 后产品功能完整、安全基线冻结。Phase 9 = **UX & Performance 收口**：不加新功能、不重构 Phase 2–8、不触碰已冻结的安全边界（五层防线 + M1–M7 + 0006/0007 审计与门禁不变量）。

**范围红线（对照规划原文）**
- 图片性能：Lazy Loading（已有）/ Responsive Images / Thumbnail / Preview / Caching —— 只做"已有能力之上补齐 + 展示链路瘦身"，**不改动下载链路**（单图 302、ZIP、Package 均不动）。
- 页面性能：Pagination / Infinite Scroll **二选一**（本次决策定形态）、Code Splitting、Caching —— 不引入数据缓存框架（不重构数据获取架构）。
- UX 完善：Loading / Empty / Error / Success Toast / Confirm Dialog（已有）/ 404 / 403 / Network / Upload / Download 错误态——**逐项盘点补齐**。
- 9.1 Responsive：公开侧已响应式；Admin 移动端**保持"降低复杂度"方向**（规划明示不强塞桌面后台），只做溢出修复与验收，不做 Drawer 重构。
- 9.2 Visual Polish：把既有 shadcn 模式**固化为 ACMERD Design System 基线文档 + 一致性微调**，不整体重设计、不引入 UI 组件库。
- **明确不纳入**（规划未列或属 Phase 10 / 独立提案）：拖拽排序（`swapImageOrder` 注释语义，编辑增强）、上传进度条重做、React Query/SWR 等数据层重构、移动端 Admin Drawer、缩略图生成的后台批处理管线。

**生产数据规模事实（只读实测，2026-09-03）**：assets=1、published=1、images=1、storage objects=23、tags=0、audit_logs=64。→ 当前量级小，分页属**结构性防御**（素材库增长后必须），Gate 验收通过**隔离库造数**完成，不以生产小数据集代替。

---

## 2. 现状差距（逐项实测，非猜测）

| 规划要求 | 现状 | 证据 |
| -- | ---- | ---- |
| Lazy Loading | ✅ 已全站（卡片/详情 grid `loading="lazy"` + aspect 占位） | `AssetCard.tsx` L31、`AssetDetailPage.tsx` L311 |
| Thumbnail / Responsive Images | ❌ **原图直出** public URL，无缩略、无 width 档位 | `toPublicUrl()` `assets/api.ts` L177-181；卡片 `<img src={coverUrl}>` 无尺寸参数 |
| 图片变换能力 | ✅ **Supabase `/storage/v1/render/image` 实测可用**（真实对象 40×40 cover 返回 200 image/png）→ 无需 Worker 代理 | 只读实测 2026-09-03 |
| 图片缓存 | ⚠️ Storage 对象响应 `Cache-Control: no-cache` | 只读实测（真实对象 GET 头） |
| Pagination | ❌ Home 全量 `.select('*')`；Search `search_assets` 无 LIMIT；AdminAssets `listAllAssets` 全量 | `HomePage.tsx` L13-22、`0005_search_and_tags.sql` search_assets 无 limit、`AdminAssetsPage.tsx` L30 |
| 分页 UI 先例 | ✅ AdminUsers 数字分页控件完整（page/totalPages/prev/next + envelope total） | `AdminUsersPage.tsx` L35-133 |
| Code Splitting | ❌ App.tsx 全静态 import（公开 5 页 + admin 8 页同 bundle） | `App.tsx` L1-20 |
| Loading / Empty / Error | ✅ 基本态遍布各页（Spinner + Empty + Error 文案） | Home/Search/AdminAssets/Detail |
| Success Toast | ❌ 仅 Detail 页有**局部**下载 toast；Admin 发布/删除等成功操作**静默无反馈** | `AssetDetailPage.tsx` L386-400（局部 state） |
| Toast / Skeleton 基础设施 | ❌ 无全局 Toast Provider、无 Skeleton 组件 | components/ 无 toast、无 skeleton |
| Preview / Lightbox | ❌ 详情图点击无放大预览（仅 hover 下载 + 选择模式） | `AssetDetailPage.tsx` 图格无 onClick 预览 |
| ConfirmDialog | ✅ 已有 | `components/ConfirmDialog.tsx` |
| 404 / 403 / ErrorBoundary | ✅ 已有 | `routes/pages/ErrorPages.tsx`、`components/ErrorBoundary.tsx` |
| Responsive（公开侧） | ✅ grid-cols-2/3/4 + max-w-7xl 容器 | Home/Search/Detail |
| Responsive（Admin） | ✅ 移动端 chips 简易导航已实现（注释"Phase 9 再完善"）；⚠️ 宽表/编辑器移动溢出待验收修复 | `AdminLayout.tsx` L47-63 |
| Design tokens | ✅ shadcn 模式（CSS 变量 + tailwind 映射 + animate） | `index.css` L5-46、`tailwind.config.ts` |
| 运行时依赖 | 极简（supabase-js/react/router/hono/lucide，零 UI 库、零数据层库） | package.json |

**结论**：Phase 9 的真实增量集中在五件事——**分页（三处）· Code Splitting · 图片缩略与缓存（展示链路）· UX 反馈基建（Toast/Skeleton/Lightbox/错误态补齐）· 响应式验收与 Visual Polish 固化**。

---

## 3. 设计决策 D1–D10（请逐项裁决）

### D1 用户侧分页形态（规划：Pagination / Infinite Scroll 二选一）

- **1a 数字分页**（**建议**）：复用 AdminUsers 既有控件模式与 envelope 语义；`?page=N` 入 URL → 可分享、前进/后退天然支持；实现成本最低（先例在手）。
- 1b 无限滚动：素材浏览更顺滑，但与 URL 同步、选择/回退语义复杂，且与"页面性能可度量"目标冲突。
- 决策点：每页 24（4 列 ×6 行 / 2 列移动自适应）。

### D2 分页实现路径（本 Phase **唯一** DB 触碰面）

- **2a 三路分治**（**建议**）：
  - **Home / AdminAssets**：直接 PostgREST `.range(offset, offset+pageSize-1)` + `.count('exact')` —— **零 DB 迁移**，纯前端数据访问层小改；`published_assets` 视图与 RLS 完全不动。
  - **Search**：`search_assets` 过滤逻辑在 RPC 内（非视图可 range）。做**函数层重构**：抽取 `_search_assets_core(p_q,p_tags)` 承载原 WHERE（含全部有界校验、标签 AND、双层可见性），`search_assets(p_q,p_tags)` 改薄壳委托 core（**无参行为 100% 不变，对外契约零破坏**），新增 `search_assets_paged(p_q,p_tags,p_page,p_per_page)` 同调 core + `count(*) over()` total（行级重复，前端取首行）+ LIMIT/OFFSET。→ 单一 WHERE 事实来源，杜绝双份逻辑漂移。
- 2b 新增独立 count RPC（两次 roundtrip + WHERE 重复）——不采纳。
- 决策点：OFFSET 分页的深分页代价在数据量达到 ~万级前可接受，届时再评估 keyset（记录为边界，不预建）。

### D3 Code Splitting

- **3a 路由级 React.lazy**（**建议**）：公开 5 页一组 + Admin 8 页一组（或逐页），`<Suspense fallback={<Spinner/>}>` 包裹；`RequireAuth/RequireRole` guard 位置不变（鉴权逻辑不移动）。Vite 自动分 chunk。无安全面。
- 3b 维持单 bundle（构建产物约可降 60%+ 首包）——不建议。

### D4 图片缩略图与响应式展示

- **4a Supabase transform 两档参数**（**建议**，能力已实测）：展示链路一律不直出原图：
  - 封面卡片（4:3）：`resize=cover&width=640&height=480&quality=80`
  - 详情网格（1:1）：`resize=cover&width=640&height=640&quality=80`
  - `toPublicUrl` 扩展为 `makeImageSrc(storagePath, opts)`；`getCoverUrls` 返回缩略 URL；详情图 `<img>` 用缩略 URL。
  - **下载链路不变**：单图/ZIP 仍走 worker 按 `imageId` 校验后取**原图对象**——缩略图只服务展示，权限语义与 Phase 5/8 完全一致。
- 4b Worker 代理缩略（扩 scope、需自建 resizing/缓存）——不采纳。

### D5 图片缓存策略

- **5a 上传时写 cacheControl**（**建议**）：`storage.ts` upload 增加 `cacheControl: 'public, max-age=31536000, immutable'`（supabase-js 原生支持）→ **新增对象**缓存一年；存量对象（生产仅 1 张演示图 + 23 对象）量级可忽略，是否补设元数据作为可选项记录。
- 备选：接受现状（no-cache 由 Supabase CDN 边缘兜底）。**不做** Worker 媒体代理（避免扩 scope 引入新端点/新缓存失效面）。

### D6 全局 Toast（Success/Error 反馈基建）

- **6a 自建 ToastProvider**（**建议**）：轻量 context（~120 行），维持项目**零 UI 运行时依赖**原则；Admin 发布/删除/保存等成功与失败统一 `toast.success/error`；替代 Detail 页局部 toast。
- 6b 引入 sonner/radix —— 功能全但破坏"零依赖"现状。
- 决策点：Toast 位置（bottom-center）、自动消失 4s、可手动关闭（对齐 Detail 页现有行为）。

### D7 Preview / Lightbox

- **7a 详情页自建全屏预览 overlay**（**建议**）：非选择模式下点击图片 → fixed overlay 显示原图大图 + 文件名 + 单图下载按钮 + 关闭；键盘 Esc 关闭；选择模式下点击仍为勾选（模式互斥已由 Detail 页状态机承载）。零依赖。缩略图展示、**预览加载原图**（展示原图合规：其权限语义 = 登录态下载才受限，预览仅在 asset 已公开上下文，与公开对象一致——不越权）。
- 7b 引入 lightbox 库 —— 不采纳（保持零依赖 + 模式互斥需深度定制）。

### D8 Loading 骨架

- **8a 补 Skeleton 组件 + 卡片网格骨架**（**建议**）：`CardSkeleton`（aspect 占位 shimmer/静态）、详情网格骨架；小面积操作仍用 Spinner。替换图片加载期空 aspect 块的观感。

### D9 Responsive 收口 + Visual Polish 固化

- **9a 收敛式**（**建议**）：
  - Admin：宽表格（Users/Audit/Storage）外层加 `overflow-x-auto` 容器；AssetEditor 移动端表单堆叠修复；导航维持 chips（规划允许降复杂度）。
  - 公开侧：Detail 侧栏（Package）移动端改为折叠/自然下排；ZIP 底部浮条与 Toast 高度冲突微调（均 fixed bottom，改 Toast bottom-24 或浮条上移）。
  - Visual Polish：**输出 ACMERD Design System 基线文档**（tokens 表：色板/圆角/间距 scale/字号/组件清单与用法），将现有分散内联样式的不一致点收敛到 tokens；不新增 UI 库、不重设计。
- 9b 全面重设计 / 引组件库 —— 不采纳（与"不加新功能、收口"定位冲突）。

### D10 验收形态

- **10a**：Gate G9 六类证据（SQL/隔离库/前端构建/响应式截图/安全回归/线上抽验），**全部 CONFIRMED 才宣布 G9 PASS**——与 G7/G8 同标准。响应式证据工具：临时引入 devDep `playwright`（仅 QA 用，preview server + 三断点截图入库 `evidence/responsive/`），若 Owner 不同意引依赖则改人工视口记录 + 像素规则表（备选）。

---

## 4. 改动面汇总

| 层 | 改动 | 文件（预期） |
| -- | ---- | ---- |
| DB | **0008_search_pagination.sql**（函数层重构 + 新 paged RPC；无表结构/无策略/无触发器/无审计动作变更；幂等） | supabase/migrations/0008_search_pagination.sql |
| Worker | **无改动** | — |
| 前端 · 数据层 | 分页三处 + 缩略 URL + upload cacheControl | assets/api.ts、search/api.ts、assets/storage.ts |
| 前端 · 基建 | ToastProvider、Skeleton、Lightbox | src/components/ 新增 |
| 前端 · 页面 | Home/Search/AdminAssets 分页控件；Detail Lightbox + 缩略 + Toast 接入；Admin 溢出修复；Error 态补齐 | 各 page + AdminLayout |
| 前端 · 路由 | React.lazy + Suspense | App.tsx |
| 前端 · 设计系统 | token 收敛 + 基线文档 | tailwind.config / index.css（微调）、docs/design-system.md 或 evidence |
| 证据 | 隔离库冒烟脚本、响应式截图、线上抽验、Security Review 回填 | scripts/phase9-*.mjs、docs/phase-9/** |

**不触碰清单**：audit_logs 表与 allowlist（0006/0007）、is_admin()/disabled 门禁（0006）、admin_user_mutation/admin_stats（0006）、guard_profile_disabled/guard_asset_publish/语言双门控语义（0001/0003/0008 不新增写路径）、downloads worker 端点与 ZIP 限额、Package 网盘面板、0005 标签 AND 语义、RLS 全部策略、storage 桶策略。

---

## 5. 安全边界影响分析（Owner 硬性要求：逐项说明是否触碰 G8 基线）

Phase 8 Security Review 冻结的五层防线 + M1–M7 逐项映射：

| 基线项 | Phase 9 影响 | 判定 |
| -- | ---- | ---- |
| L1 RLS 全部策略（含 published 双层可见性） | 分页读经 SECURITY INVOKER RPC / 既有视图 / PostgREST，策略零改动；Home/AdminAssets 用 `.range()` 不改变返回行权限过滤 | **不受影响**（隔离库 NO-DRIFT 复验） |
| L2 Worker 鉴权 + disabled 门禁 | Worker 零改动 | **不受影响** |
| L3 审计（18→24 allowlist + 触发器） | 无任何写路径新增 → 无新审计动作；RPC 重构不触发表 | **不受影响** |
| L4 Secret 管理 | 无新密钥；cacheControl/transform 均为平台既有能力 | **不受影响** |
| L5 Admin 原子变更 + last-admin | 不触碰 admin RPC | **不受影响** |
| M1 越权（Guest/User→Admin） | 分页端点均为既有权限面；新增前端组件无数据通道 | **不受影响** |
| M2 disabled 用户访问 | Worker 门禁未动；前端 lazy 不旁路 guard | **不受影响** |
| M3 用户直写 DB | 无新写面 | **不受影响** |
| M4 审计完整性 | 0008 重构 search RPC 不产生写 → 不新增审计盲区 | **不受影响** |
| M5 存储越权 | transform 仅读已公开对象（Phase 8 D5 残余风险边界内，**无新增暴露面**：原图 URL 本就可 GET，缩略参数不改变对象可见性） | **不受影响**（风险等级不变） |
| M6 Secret 泄漏 | 新增前端代码无密钥 | **不受影响**（Security Review 复扫可选） |
| M7 公开集合不漂移 | **核心回归点**：search_assets 薄壳化后无参结果须与 0005 逐行一致；paged 并集 = 全量 | **需回归证明**（I1–I3） |

**本 Phase 安全不变量（实施与验收强制）**
- **I1** `search_assets`（无参调用）结果与 0005 现网实现**逐字节一致**（薄壳重构的唯一正确性判据）。
- **I2** `search_assets_paged` 任一合法 (page,per_page) 分页并集 = 全量结果，且与 I1 全量一致（无丢失/无重复/无新增可见行）。
- **I3** 0008 应用前后，Guest 视角公开数据集合（published_assets + asset_languages published 计数语义）**不漂移**（沿用 Phase 8 快照 A/B 法，快照集与 0007 证据一致）。
- **I4** RLS / allowlist 24 / disabled 门禁 / admin RPC 在 0008 隔离库上仍通过 Phase 8 抽样用例（C10 负样本 + is_admin 三态 + last-admin 语义不适用读路径故仅抽样）。

---

## 6. 测试与证据（Gate G9 七类，全 CONFIRMED 才 PASS）

| # | 证据 | 方法 |
| -- | ---- | ---- |
| 1 | 实际 SQL | 0008 全文（薄壳 + core + paged 函数体；隔离库实测） |
| 2 | 隔离库验证 | 一次性库 0001→0008 全量应用：I1a 契约不变 / I1b canonical JSON 一致 / I2 分页并集=全量 / I2a 顺序一致 / I3 NO-DRIFT / I4 Phase 8 抽样；**造 30+ 资产、多 Tag、多语言多图**验证分页语义（生产仅 1 条，必须隔离库造数） |
| 3 | 前端构建 | typecheck + `vite build`；lazy 前后 chunk 对比（首包降幅） |
| 4 | 响应式证据 | preview server + 截图（Desktop 1280 / Tablet 768 / Mobile 390）三视口 × 关键页（Home/Search/Detail/Admin Assets/Admin Users） |
| 5 | UX 状态回归 | 每页 Loading/Empty/Error/Success Toast 抽查清单（含 404/403/Network） |
| 6 | 生产应用 + 线上抽验 | 0008 上生产（schema_migrations 记录）；线上只读抽查：分页 envelope、thumb URL 200、search 无参兼容 |
| 7 | **性能证据（D10 新增）** | **Baseline → Implementation → Compare**：改造前记录初始 bundle 体积 / 关键页网络请求数 / 展示图片字节数基线；改造后复测，证明 lazy 拆分生效、分页避免全量拉取、图片走 transform、无明显 layout overflow、请求数无异常膨胀。**不硬定绝对 LCP 阈值**（环境无稳定 benchmark）。 |

**Gate G9 判据（规划原文对齐）**：Desktop / Tablet / Mobile PASS；Loading / Error / Empty State PASS；Image Performance PASS（缩略图实际字节 vs 原图对比 + lazy 已具）；**七类证据全 CONFIRMED**。

---

## 7. Owner 裁决（已落档 · 2026-09-03）

```text
Phase 9 Design Gate = APPROVED WITH REQUIRED ADJUSTMENTS

D1 = APPROVED（1a 数字分页）
  边界：固定 pageSize；越界页不报错、空页正常返回；排序稳定（updated_at DESC, id ASC）；
  分页查询与 total 查询必须使用同一筛选条件；page=N 结果不得随数据变化漂移。

D2 = APPROVED WITH GUARDRAILS（2a）
  _search_assets_core → 薄壳 search_assets（对外契约零破坏）→ 新增 search_assets_paged。
  I1a 原 search_assets 的签名/返回列/字段类型/NULL 语义/Tag AND/wildcard escaping/排序全部不变。
  I1b 固定 fixture 下，旧 search_assets 结果与 core 结果 canonical JSON 完全一致。
  I2  分页并集 = 全量，无遗漏/无重复。
  I2a 分页拼接后的顺序与全量查询完全一致。
  paged 的 total 不得改变原 search 的筛选语义（不为分页顺手改搜索规则）。
  隔离库必须造 30+ assets 验证，禁止依赖生产 1 asset 数据。

D3 = APPROVED（3a React.lazy）
  Guard 顺序必须保持 Auth → Guard → Lazy Page，不得出现"先渲染页面再发现无权限"。

D4 = APPROVED（4a Supabase transform 两档：封面 640×480 / 详情 640×640）
  transform 仅用于展示；下载原图/ZIP 链路（storage path/鉴权/文件名/语义）完全保持 Phase 5 不变量。
  缩略 URL 生成集中到一个 helper，禁止各页各写一套 query 参数。

D5 = APPROVED（5a upload cacheControl=immutable）
  immutable 仅用于"唯一路径的新对象"（当前路径含 UUID 随机前缀，成立）；
  不得对"同路径覆盖写"的对象打 immutable；历史对象不批量迁移缓存策略。

D6 = APPROVED（6a 自建 ToastProvider）
  最小统一行为：success/error/info + 自动消失 + 手动关闭 + 多 toast 不互相覆盖；
  不引入通知系统/全局事件总线。

D7 = APPROVED（7a 自建 Lightbox）
  至少保证：Esc 关闭、关闭后焦点回到触发图片、移动端无页面/overlay 双滚动冲突。

D8 = APPROVED（8a CardSkeleton）
  骨架尺寸/图片比例与最终卡片一致，避免明显 CLS（与 D4 缩略比例一并锁定）。

D9 = APPROVED（9a 收敛式 Responsive + Visual Polish）
  不重构 Drawer、不引入新 UI framework/design dependency；
  Design System 基线文档保持轻量（字体层级/spacing/radius/shadow/form control/状态色）；
  移动端优先修"功能可用性"（表格横向溢出、按钮挤压、侧栏、详情图区），非视觉重做。

D10 = MODIFY → 七类证据 + Performance Evidence（Baseline → Implementation → Compare）
  在原六类证据外，新增第 7 类「性能证据」：初始 bundle 因 lazy 拆分、
  Home/Search/AdminAssets 分页避免全量拉取、图片走 transform 非原图、
  典型移动/桌面视口无明显 layout overflow、关键页网络请求数无异常膨胀。
  不硬定绝对 LCP 阈值（环境无稳定 benchmark），以 Baseline→Implementation→Compare 证明无倒退 + 三大收益有证据。

隐藏硬约束（写入本 Gate）：
  生产仅 1 asset/1 image，不得作为分页验证依据；分页必须隔离库 30+ assets、多 Tag、多页 Search，
  并验证 page1+…+last 拼接与旧全量完全一致。
  0008 是本 Phase 唯一 DB 变更面；published_assets / is_admin() / RLS / audit / disabled 门禁
  视为【冻结基础设施】，除 search_assets 分页扩展外不得触碰 Phase 8 安全语义。

实施顺序：0008 → 隔离库分页/NO-DRIFT（I1a/I1b/I2/I2a/I3/I4 + D1 边界）→ 前端 UX →
Performance Evidence → 生产 0008 + 线上抽验 → Security Review 回填 → Git + Gate G9。
```

**批准人**：Owner · **批准日期**：2026-09-03 · **状态**：APPROVED，进入实施。
