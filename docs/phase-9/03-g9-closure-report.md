# Phase 9 · Gate G9 Closure Report — 响应式运行时证据补齐 → G9 PASS

> 文档性质：Gate 关闭报告（Owner 裁决「选 C」的执行结果）
> 日期：2026-09-04 · 执行环境：本会话 QA 环境（agent-browser 真实 Chromium 152.0.7977.82，非 Playwright，未给项目引入任何新依赖）
> 前置：`docs/phase-9/02-implementation-report.md` §六 Owner 裁决（G9 = PENDING，6/7 CONFIRMED，仅缺第④类运行时证据）

---

## 一、结论（TL;DR）

**Gate G9 = PASS（7/7 类证据 CONFIRMED）。**

- 第④类「响应式运行时截图/视口证据」已在真实浏览器环境中补齐：三视口（Desktop 1280 / Tablet 768 / Mobile 390）× 关键页（Home / Search / Asset Detail / Admin Console 全部 7 页）+ Lightbox 交互实测，截图 27 张入库 `docs/phase-9/evidence/responsive/`。
- **证据采集过程中发现并修复了 1 个真实缺陷（DEF-9-1）**：Admin Users / Audit Logs 在 Tablet/Mobile 视口存在**页面级横向溢出**（正是本类证据设计要抓的问题）。修复为 `AdminLayout.tsx` 单类名变更（`flex-1` → `min-w-0 flex-1`），属于已批准 D9 范围（"Admin 移动端优先修表格横向溢出"），非扩 scope。
- 修复已本地验证 → 生产部署（新 bundle `index-DosBFCeX.js`）→ 生产三视口复检通过。
- 未重跑已通过的 DB / Search / Security / Download / Performance 证据（遵守 Owner 裁决）。
- **下一步解锁：Phase 10 — Production Release（严格"全量回归 + 发布"，不塞新功能）。**

---

## 二、证据采集方法（客观可复核）

| 维度 | 值 |
| --- | --- |
| 目标环境 | 生产 https://image.acmerd.com（采集开始时 bundle `index-BthmGVpj.js`；DEF-9-1 修复后 `index-DosBFCeX.js`） |
| 浏览器 | agent-browser 管理的真实 Chromium 152.0.7977.82（headless），**非 Playwright、项目零新增依赖** |
| 视口 | Desktop 1280×800 / Tablet 768×1024 / Mobile 390×844（与 Design Gate D10 定义一致） |
| 溢出判定 | 运行时 JS 评测：`document.documentElement.scrollWidth` vs `clientWidth`（含逐元素 `getBoundingClientRect` 定位溢出源），附像素数值 |
| 交互实测 | Lightbox 开/关（点击触发、Esc 关闭、滚动锁、焦点回归）、Admin 登录态导航（凭据来自 `.env`，仅只读查看，**零变更操作**） |
| 证据目录 | `docs/phase-9/evidence/responsive/`（27 张 PNG，命名 `<viewport>-<page>.png`） |

**环境坑（供后续 Agent 复用）**：本环境 agent-browser 守护进程会在 Bash 调用间随机重置标签页/视口/会话 → 采取「`set viewport` + `open` + `eval` 校验 + `screenshot` 全部同命令链执行」的防御模式；曾出现 2 张截图先于导航执行而拍到空白页（desktop-home / desktop-lightbox），已识别并重拍有效版本。

---

## 三、运行时证据矩阵（修复后终态）

图例：✅ 无页面级溢出（docScrollW == clientW）· ❌ 页面级横向溢出 · `内滚` = 表格在 overflow-x-auto 容器内滚动（D9 设计意图）

### 公开侧（Guest 视角）

| 页面 | Desktop 1280 | Tablet 768 | Mobile 390 |
| --- | --- | --- | --- |
| Home | ✅ 1280/1280 | ✅ 768/768 | ✅ 390/390 |
| Search | ✅ 1249/1249（15px 滚动条） | ✅ 768/768 | ✅ 390/390 |
| Asset Detail | ✅ 1249/1249 | ✅ 768/768 | ✅ 390/390 |
| Grid 断点 | 4 列（lg） | 3 列（sm） | 2 列 |
| 导航 | 桌面横向 | 同桌面 | 正常折行、无遮挡 |

### Admin Console（admin 登录态）

| 页面 | Desktop 1280 | Tablet 768 | Mobile 390 |
| --- | --- | --- | --- |
| Dashboard | ✅ | ✅ 753/753 | ✅ 375/375 |
| Assets | ✅ | ✅ 753/753 | ✅ 375/375 |
| Users | ✅ 1265/1265 | ✅ 753/753（修复前 ❌ 1094/753）容器 479px 内滚 820px | ✅ 375/375（修复前 ❌ 870/375）容器 325px 内滚 820px |
| Audit Logs | ✅ | ✅ 753/753 | ✅ 375/375（修复前 ❌ 910/375） |
| Tags / Storage | ✅ | ✅ | ✅ 375/375 |
| 导航 | 侧栏（md:） | 侧栏（768 恰触发 md:） | chips 简易导航，正常 |

### Lightbox / UX 交互实测（Desktop + Mobile）

| 检查项 | 结果 |
| --- | --- |
| 点击图片打开全屏 overlay（`.fixed.inset-0.z-50 bg-black/90`，显示原图 + 文件名 `tu1.jpg`） | ✅ |
| Esc 关闭 | ✅（Desktop/Mobile/Tablet 三视口均验证） |
| 关闭后焦点回归触发元素 | ✅ 落点为包裹触发图的预览按钮 `BUTTON[aria-label="Preview tu1.jpg"]`（触发图本身被 button 包裹，符合 D7 语义） |
| 背景滚动锁（overlay 打开期间） | ✅（`overflow: hidden` 生效；关闭后解锁） |
| 移动端无页面/overlay 双滚动冲突 | ✅（Mobile overlay 截图无遮挡、无第二滚动条） |

---

## 四、DEF-9-1：证据采集中发现并修复的缺陷

> 本节如实记录「运行时证据 ≠ 代码审查结论」的实证案例：第④类证据恰恰抓到了代码级审查判"无结构性横向溢出"的真实缺陷。

**现象**：Tablet 768 / Mobile 390 下，`/admin/users` 与 `/admin/audit-logs` 页面级横向溢出（文档 scrollWidth 1094/870/910 vs clientWidth 753/375），整页可左右晃动，`overflow-x-auto` 容器失效。

**根因**（运行时逐元素定位 + 源码核对）：`AdminLayout.tsx` 内容区 `<div className="flex-1 p-6">` 为 flex 子项，缺 `min-w-0`（flex 子项默认 `min-width: auto` 不可收缩）→ 宽表格把内容区撑到内容最小宽度（870px）→ 内层 `overflow-x-auto` 容器被撑宽后表格"装得下"（contScrollW == contClientW == 820），内部滚动不触发 → 溢出转移到页面级。另：768 恰好触发 Tailwind `md:` 断点（桌面侧栏 224px 出现），加剧 Tablet 溢出。

**修复**（`src/components/layout/AdminLayout.tsx` 单处，+2 行注释 +1 个类名）：

```diff
-      <div className="flex-1 p-6">
+      <div className="min-w-0 flex-1 p-6">
```

**范围合规**：属于 Owner 已批准的 D9 裁决范围（"Admin：宽表格外层加 overflow-x-auto 容器…移动端优先修『功能可用性』（表格横向溢出…）"），为完成既有批准项，非设计变更、非扩 scope。**触碰面**：纯 CSS 类名，无 JS 逻辑/无 DB/无 Worker/无 RLS/无审计语义变化——G8 冻结基线零触碰。

**验证链**（完整四步）：
1. `npm run typecheck` → 0 错误；`npm run build` → 成功，入口 445.22 kB / 129.37 kB gzip（修复前基线 129.36 kB，+0.01 kB，无性能倒退）。
2. 本地 `wrangler dev`（:4173）验证：Mobile 390 Users `375/375` ✅ 容器 325px 内滚 820px；Audit `375/375` ✅；Tablet 768 Users `753/753` ✅ 容器 479px 内滚 820px；Desktop 1280 `1265/1265` ✅ 无回归。（`FIX-VERIFY-*-local.png` ×4）
3. 生产部署：`wrangler deploy`（经 `.env` 凭据）→ 判别器核验生产 HTML 已引用新 bundle `index-DosBFCeX.js`（旧 `index-BthmGVpj.js`）。
4. 生产三视口复检：Users/Audit/其余 Admin 页全部无页面级溢出（§三矩阵终态）；受影响截图全部重拍，缺陷版截图保留为 `defect-FOUND-*.png` ×3 以证发现过程。

---

## 五、证据文件清单（docs/phase-9/evidence/responsive/，27 张）

| 组 | 文件 |
| --- | --- |
| Desktop 公开（修复前 bundle，公开页不受 DEF-9-1 影响） | desktop-home.png*、desktop-search.png、desktop-asset-detail.png、desktop-lightbox.png* |
| Desktop Admin | desktop-admin-dashboard.png、desktop-admin-assets.png（修复前，桌面本无缺陷）、desktop-admin-users.png（修复后重拍） |
| Tablet 公开 | tablet-home.png、tablet-search.png、tablet-asset-detail.png、tablet-lightbox.png |
| Tablet Admin | tablet-admin-dashboard.png、tablet-admin-assets.png（修复前，无缺陷）、tablet-admin-users.png（修复后重拍）、tablet-admin-audit-logs.png（修复后新增） |
| Mobile 公开 | mobile-home.png、mobile-search.png、mobile-asset-detail.png、mobile-lightbox.png |
| Mobile Admin | mobile-admin-dashboard/assets/storage/tags.png（修复前，无缺陷）、mobile-admin-users.png、mobile-admin-audit-logs.png（修复后重拍） |
| 缺陷发现证据 | defect-FOUND-tablet-admin-users-prerefix.png、defect-FOUND-mobile-admin-users-prerefix.png、defect-FOUND-mobile-admin-audit-prerefix.png |
| 本地修复验证 | FIX-VERIFY-mobile-admin-users-local.png、FIX-VERIFY-mobile-admin-audit-local.png、FIX-VERIFY-tablet-admin-users-local.png、FIX-VERIFY-desktop-admin-users-local.png |

\* desktop-home / desktop-lightbox 因守护进程重置拍到空白页，已重拍为有效版本（重拍内容与旧 bundle 渲染一致，公开页不受修复影响）。

---

## 六、对既有六类证据的影响声明（均无影响，未重跑）

| 已 CONFIRMED 证据 | DEF-9-1 修复影响 | 判定 |
| --- | --- | --- |
| ① 实际 SQL（0008） | 无 DB 变更 | 无影响 |
| ② 隔离库 15/15（I1a/I1b/I2/I2a/I3/I4） | 无 DB/逻辑变更 | 无影响 |
| ③ 前端构建 | 修复后重新 typecheck+build 均绿，入口 gzip +0.01 kB | 无倒退 |
| ⑤ UX 状态回归 | 纯 CSS 类名，状态机/交互逻辑零改动 | 无影响 |
| ⑥ 生产应用 + 线上抽验 | Worker 零改动；新部署仅静态资源哈希变化 | 无影响 |
| ⑦ 性能 Baseline→Compare | 入口 129.36→129.37 kB gzip（+0.01），chunk 结构不变 | 无倒退 |
| G8 安全基线（五层防线/M1–M7） | AdminLayout 是纯布局组件，无数据通道、无权限语义 | 零触碰 |

## 七、Gate G9 状态

```text
G9 = PASS（7/7 CONFIRMED）

① 实际 SQL          CONFIRMED（0008，见 02 报告）
② 隔离库验证        CONFIRMED（15/15，见 02 报告）
③ 前端构建          CONFIRMED（修复后复验 typecheck=0 / build 绿）
④ 响应式运行时证据  CONFIRMED（本报告 §三/§五；含 DEF-9-1 发现→修复→复验闭环）
⑤ UX 状态回归       CONFIRMED（见 02 报告）
⑥ 生产应用+线上抽验 CONFIRMED（见 02 报告；本次部署后 bundle=index-DosBFCeX.js）
⑦ 性能证据          CONFIRMED（见 02 报告；修复后入口 +0.01 kB gzip 无倒退）

依据：Owner 裁决「选 C」（02-implementation-report.md §六）——
能出真实浏览器运行时截图的 QA 环境中仅补第④类，补齐后直接出本 Closure Report 宣布 G9 PASS。
```

**下一步：Phase 10 — Production Release**（总纲定义：无新功能，严格"全量回归验证 + 发布"；回归时复用 02 报告 §六所列不变量 I1a/I1b/I2/I2a/I3/I4 与 Phase 8 抽样用例）。
