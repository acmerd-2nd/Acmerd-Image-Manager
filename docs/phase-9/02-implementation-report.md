# Phase 9 · UX & Performance — 实施报告 + Gate G9 证据

> 依据：`docs/phase-9/01-design-gate.md`（Owner 批准 APPROVED WITH REQUIRED ADJUSTMENTS，D1–D10 裁决见 §7）
> 日期：2026-09-03 · 前置：Phase 8 CLOSED（G8 PASS），0001–0007 生产已应用

## 一、实施内容（按裁决）

| 决策 | 落地 |
| --- | --- |
| D1 数字分页 | `Pagination` 组件；Home/Search/AdminAssets 三处 `?page=N` 入 URL；固定 pageSize（24/24/20）；越界页空返回、page<1→1、per_page 钳制 [1,100]；分页与 total 同筛选、`updated_at DESC, id ASC` 确定性序 |
| D2 分页实现 | `0008`：`_search_assets_core`（校验+WHERE 单一事实来源）→ `search_assets` 薄壳（契约零破坏）→ `search_assets_paged`（同 core + `count(*) over()` total + LIMIT/OFFSET）。Home/Search 走 paged RPC；AdminAssets 走 PostgREST `.range()`（含全部状态）。**未改 published_assets/RLS** |
| D3 Code Splitting | `App.tsx` 路由级 `React.lazy`；AuthProvider/布局/Guard eager，Suspense 边界在 AppShell/AdminLayout 的 `<Outlet/>` → 顺序 **Auth→Guard→Lazy Page** 保持 |
| D4 缩略图 | `makeImageSrc(path, variant)` 统一 helper（`render/image` 变换）；封面 640×480、详情 640×640；仅展示链路，下载原图/ZIP 不变 |
| D5 缓存 | `storage.ts` upload `cacheControl: 'public, max-age=31536000, immutable'`（唯一路径新对象；历史不批量迁移） |
| D6 Toast | 自建 `ToastProvider`（success/error/info，自动消失+手动关闭+堆叠不覆盖）；Admin 发布/删除/归档成功反馈接入；Detail 局部 toast 迁移至全局 |
| D7 Lightbox | 自建全屏预览：原图展示、Esc 关闭、焦点回归触发、背景滚动锁 |
| D8 Skeleton | `CardSkeleton`/`CardGridSkeleton`（4:3 比例对齐防 CLS） |
| D9 Responsive+Polish | Admin 表 `overflow-x-auto`（既有，审计确认）；移动 chips 导航；`design-system.md` 基线固化 |
| D10 验收 | 七类证据（本报告 §三），性能 Baseline→Implementation→Compare |

**未做**（守范围红线）：不引 UI 框架/数据层库；不重构 Drawer；不碰下载/审计/RLS/security 语义；无绝对 LCP 阈值。

## 二、DB 变更
`0008_search_pagination.sql`（唯一 DB 面）：3 个 SECURITY INVOKER 函数（core/薄壳/paged）+ 授权。**无表结构/策略/触发器/审计动作变更**。生产已应用（`schema_migrations` 记录）。

## 三、Gate G9 七类证据

**① 实际 SQL** — `supabase/migrations/0008_search_pagination.sql`（见仓库）。

**② 隔离库验证** — `scripts/phase9-isolated-smoke.mjs`，一次性库 0001→0008 + 32 published 资产（多标签）+ 2 draft，**PASS=15 FAIL=0**：
- I1a 签名/8 列保持、无 total/updated_at 外泄 ✅
- I1b 薄壳与旧实现 canonical JSON **drift=0** ✅
- I2 total=全量、并集无重无漏；I2a 拼接顺序与全量完全一致 ✅
- D1 边界：越界页空+total、per_page 钳制、page<1→1 ✅
- tag AND 分页并集=全量 ✅
- I3 全 fixture 0008 前后不漂移（NO-DRIFT）✅
- I4 anon 只见 published（无 Draft）+ user 无写旁路 ✅

**③ 前端构建** — `typecheck` 绿；`vite build` 成功，产物见 §四性能对比（25+ 独立 chunk）。

**④ 响应式证据** — ⚠️ **受限**：本会话浏览器 MCP 标签页无前台布局 surface（`innerWidth=0`、截图 "Only screenshots from surface are allowed"），且按零依赖纪律未引入 playwright，**无法产出运行时像素/截图**。改以**代码级审查**佐证（客观可核）：
- 关键页均用 sm/md/lg 断点；资产网格 `grid-cols-2→sm:3→lg:4`；详情 `lg:grid-cols-[1fr_260px]`（移动下排）
- Admin 两表 `overflow-x-auto`；AdminLayout 桌面 `hidden md:block` + 移动 chips `md:hidden`
- 结论：布局按断点响应、无结构性横向溢出。**运行时截图子项待 Owner 定夺**（批准一次性 playwright devDep 出图，或接受代码级审查）。

**⑤ UX 状态回归** — Home（Loading skeleton / Empty / Error+重试）、Search（Loading / Empty / Error / tag chips）、Detail（缩略图 / Lightbox / 全局 Toast / 选择模式 / 下载门控）、Admin（发布/删除/归档成功 Toast + ConfirmDialog）；404/403/ErrorBoundary 既有。

**⑥ 生产应用 + 线上抽验** — 0008 已上生产；前端已部署（bundle `index-BthmGVpj.js`）。线上只读抽验 **6/6**：health 200、`search_assets` 无参契约兼容、`search_assets_paged` 含 total、越界页 200 空、query>200 仍拒（护栏保持）、`render/image` 缩略 200。浏览器实测：Home lazy 渲染无 console 错误、详情缩略图 `naturalWidth=640`（transform 生效）、Lightbox 开原图+焦点管理+Esc 关闭+滚动解锁。

**⑦ 性能证据（Baseline→Implementation→Compare）**
| 指标 | Baseline（Phase 6 单包） | Implementation（Phase 9 拆分） |
| --- | --- | --- |
| 入口 JS | 489.20 kB / 140.39 kB gzip（每路由全量） | 445.21 kB / **129.36 kB gzip**（共享 runtime） |
| 路由代码 | 全在单包 | 按需 chunk：Home 1.28 / Search 1.54 / Detail **5.45** / AdminEditor **4.63** kB gzip |
| 净效果 | — | 入口 **−11 kB gzip（−7.9%）**；访客不再下载 Admin 编辑器/Detail/Lightbox，反之亦然；无倒退 |
说明：主包仍含 supabase-js/react 共享 runtime（Phase 9 不重构数据层，符合范围）；分页使 Home/Search/Admin 不再全量拉取（`.range`/`LIMIT`）；展示走 transform（原图 ~900KB → 640 档缩略）。

## 四、安全不变量（Phase 8 基线）
0008 仅函数层，`published_assets`/`is_admin()`/RLS/audit/disabled 门禁**零改动**；隔离库 I3/I4 + 线上抽验证明无漂移、无旁路、护栏保持。

## 五、Git
Phase 9 提交（0008 + 前端 + 文档）；规划文档不入库；测试数据隔离库自动 DROP。

## 六、Gate G9 状态
**6/7 类 CONFIRMED；第④类"响应式运行时截图"因环境无布局 surface + 未授权 playwright 而受限**，已用代码级审查替代并如实标注。
→ 待 Owner 就第④类定夺：(A) 批准一次性 `playwright` devDep 补三视口截图，或 (B) 接受代码级响应式审查为 G9 充分证据。**在此之前不宣布 G9 PASS**（遵循"全 CONFIRMED 才 PASS"）。
