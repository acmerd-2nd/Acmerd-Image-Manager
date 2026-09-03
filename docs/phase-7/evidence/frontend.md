# Phase 7 · 前端 Admin Console 实装 — 证据

> 批次：C（前端批次） · 执行：软件工程师（寇豆码） · 日期：2026-09-03
> 依据：`docs/phase-7/01-design-gate.md` §8（前端改动表）/ §6 / 附录 A4；批次 B 产出 `worker-endpoints.md` 契约
> 状态：**4 页实装 + AuthProvider disabled 感知 + 侧栏/路由收敛 + Settings 全清 · `npm run typecheck` 0 错误 · `npm run build` 成功**
> 红线核对：未 git；未改 `supabase/migrations/`、`worker/`、Assets/Tags/Search/Download 既有业务逻辑与样式；未放宽 user_roles RLS/GRANT；Settings 路由/侧栏/文件/引用已全部清除；`.env` 值未写入文件/消息。

---

## 0. 改动文件清单

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| 新建 | `src/features/admin/api.ts` | Worker admin 端点客户端层：`listAdminUsers` / `changeUserRole` / `setUserDisabled` / `getAdminStats`；统一 Bearer、统一解码 `{error:{code,message}}`，已知错误码转中文提示 |
| 新建 | `src/routes/pages/admin/AdminDashboardPage.tsx` | Dashboard 真实页（统计卡 + 语言分布） |
| 新建 | `src/routes/pages/admin/AdminUsersPage.tsx` | Users 真实页（表格/分页/改角色/禁用启用/self 置灰） |
| 新建 | `src/routes/pages/admin/AdminStoragePage.tsx` | Storage 只读页（Used/Image Count/By Language + D5 口径标注） |
| 新建 | `src/routes/pages/admin/AdminAuditLogsPage.tsx` | Audit Logs 页（admin JWT 直连 audit_logs，D4） |
| 修改 | `src/features/auth/AuthProvider.tsx` | role 查询与本人 `profiles.disabled` 并行取；disabled → 生效身份按 'user'，暴露 `disabled/isDisabled` |
| 修改 | `src/components/layout/AdminLayout.tsx` | 侧栏收敛为 6 项（Dashboard/Assets/Users/Tags/Storage/Audit Logs），删除 Settings |
| 修改 | `src/App.tsx` | 路由引用真实页；删除 `/admin/settings` 路由与 Settings 引用 |
| 修改 | `src/types/database.ts` | 追加 `AuditLogRow` 类型 |
| 修改 | `src/features/downloads/api.ts` | 用户端最小改动：下载失败分支识别 `account_disabled` → “账号已被禁用，请联系管理员”（不改路由/功能） |
| 删除 | `src/routes/pages/admin/AdminPlaceholderPages.tsx` | 四个占位页 + Settings 占位页 + 冗余 AdminTagsPage 占位一并移除（引用已全清） |

---

## 1. 每页消费的契约与错误码映射

### 1.1 `features/admin/api.ts`（客户端层）

- 统一 `request<T>()`：`supabase.auth.getSession()` 取 access_token → `Authorization: Bearer` → `fetch('/api/...')` → 非 2xx 解码 `{error:{code,message}}` → 抛 `AdminApiError(status, code, 中文 message)`。
- 已知错误码 → 中文（页面直接展示 `e.message`）：

| code | HTTP | 展示文案 |
| --- | --- | --- |
| `account_disabled` | 403 | 账号已被禁用，请联系管理员 |
| `forbidden` | 403 | 操作被拒绝：不能对自己降级或禁用，或你的管理员权限已失效 |
| `last_admin` | 409 | 系统必须保留至少一名活跃管理员，无法完成该操作 |
| `not_found` | 404 | 目标用户不存在（可能已被删除） |
| `bad_request` | 400 | 请求参数有误，请刷新后重试 |
| `unauthorized` | 401 | 登录状态已失效，请重新登录 |
| `upstream_error` | 502 | 服务暂时不可用，请稍后重试 |
| 其他 | — | 服务端 message / `请求失败（HTTP n）` |

- 函数签名（批次 B 契约逐字对齐）：
  - `listAdminUsers({page, perPage})` → `GET /api/admin/users?page=&per_page=` → `AdminUsersEnvelope {users,total,page,per_page}`
  - `changeUserRole(userId, 'user'|'admin')` → `POST /api/admin/users/:userId/role` → `{user_id,role,disabled,role_changed,disabled_changed}`
  - `setUserDisabled(userId, boolean)` → `POST /api/admin/users/:userId/disabled` → 同上
  - `getAdminStats()` → `GET /api/admin/stats` → 7 键透传

### 1.2 DashboardPage
- 数据源：**一次 `getAdminStats()`**（禁止拆多请求）。统计卡 Assets（含 draft/published/archived 徽章）、Images、Users（含 disabled 数）、Storage Used；语言分布卡。
- Storage Used 卡片注明“按数据库记录估算（SUM(images.file_size)），非 Storage 实查”（D5）。
- 未实现 Recent Assets/Activity：`@/自验证` 要求 Dashboard/Storage **只发一个 stats 请求**，故不引入 listAllAssets 等第二数据通路（§8 “若实现必须复用既有查询”的保守选择）。

### 1.3 UsersPage
- 数据源：`listAdminUsers` 分页（envelope total/page/per_page，PAGE_SIZE=20）。
- 表格列：User（首字母圆形 Avatar + display_name + email）/ Role / Created / Status（active|disabled）/ Actions。
- Actions：
  - role=admin → `Make user`（self 置灰 + title“不能对自己执行降级”）；role=user → `Make admin`。
  - disabled=false → `Disable`（需 ConfirmDialog，self 置灰 + title“不能对自己执行禁用”）；disabled=true → `Enable`。
- 服务端错误展示：`account_disabled`/`last_admin`/`forbidden` 等经 api.ts 中文文案直接展示；禁用确认失败时关闭对话框并把错误置顶（用户可再决策）。

### 1.4 StoragePage
- 数据源：**一次 `getAdminStats()`**（与 Dashboard 同源）。
- 只读卡：Used / Image Count / Assets + By Language 分布。
- 顶部横幅强制标注 D5：“用量口径：按数据库记录估算（SUM(images.file_size)），非 Storage 实查。”

### 1.5 AuditLogsPage
- 数据源：admin JWT 经 RLS 直连 `audit_logs`（`select('*').order('created_at', desc).like('action', prefix)`，range 分页，Load more）；actor_id → profiles 批量解析 display_name（RLS admin 可读 profiles）。
- action 前缀筛选按钮：All / asset. / image. / tag. / user. / download_source.。
- 列：Time / Actor / Action / Target(type+id) / Metadata(JSON `<details>` 折叠)。
- **未新增 Worker 读端点**（D4 遵守）。

---

## 2. AuthProvider disabled 感知

- role 查询与本人 `profiles.disabled` 查询 **并行**（`Promise.all`）。
- `disabled=true` → 生效 `role` 置为 `'user'`（即使 DB 角色为 admin），使 `RequireRole(['admin'])` 守卫直接拒绝进后台；暴露 `disabled` / `isDisabled`；`isAdmin` 自然为 false（顶栏 Admin 入口消失）。
- 只动身份展示/守卫层，不触碰任何业务查询通道；RLS 层 `is_admin()`（0006）同步兜底直连。

---

## 3. Settings 移除点（自查确认）

- `src/App.tsx`：删除 `AdminSettingsPage` import 与 `<Route path="settings" …/>`。
- `src/components/layout/AdminLayout.tsx`：删除 `Settings` import 与侧栏 item。
- `src/routes/pages/admin/AdminPlaceholderPages.tsx`：整文件删除（其中 Settings 占位页与其他三个占位页、冗余 Tags 占位一并清除）。
- 全 `src/` grep `settings|Settings|Placeholder` 无残留。

---

## 4. 自验证输出

```text
> npm run typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.worker.json --noEmit
EXIT=0（0 错误）

> npm run build
> vite build
✓ 1679 modules transformed.
dist/index.html  …  dist/assets/index-*.css 20.62 kB │ gzip 4.82 kB
dist/assets/index-*.js 505.46 kB │ gzip 144.01 kB   （>500 kB chunk 为既有体积警告，非错误）
✓ built in 2.63s
EXIT=0
```

代码层面自查：Dashboard/Storage 各自仅调用一次 `getAdminStats()`，无循环/多处 fetch 拼装；AuditLogs 为独立直连查询 + actor 名解析（不受“单 stats 请求”约束）。

---

## 5. 偏差 / 假设记录（对 QA 与结束报告有约束力）

1. **Dashboard 未做 Recent Assets/Activity**：以“Dashboard/Storage 只发一个 stats 请求”自验证为准（门禁 §8 两处要求冲突时取更严格的单请求口径）。若后续要 Recent，复用既有 listAllAssets/组件即可，不作为本批数据通路。
2. **占位文件整删**：`AdminPlaceholderPages.tsx`（含 Settings 占位与冗余 Tags 占位）在确认 App 不再引用后删除，符合“引用全清”。
3. **AuthProvider 将 disabled 身份折叠为 `role='user'`**：避免改动 `guards.tsx`（不在本批白名单）。身份展示层可经 `isDisabled` 感知；Profile 页未列入本批改动文件，故未加“已禁用”展示（worker/RLS 已保证实际能力边界）。
4. **用户端仅补 account_disabled 文案**：作用于 downloads/api 403 分支（单图/ZIP），其余用户端路由/功能零改动。
5. **未做线上 UI E2E**：需部署后由任务 #5 + QA（#4）覆盖；本批证据边界 = typecheck/build + 代码契约一致性 + 静态自查。

---

## 6. 交接

- QA（#4）建议用例：disabled admin 登录 → 顶栏无 Admin、直达 /admin 被守卫拒；Users 分页/改角色/self 置灰/禁用确认；`last_admin` 409 中文提示；Dashboard/Storage 单请求数字与生产 stats 一致；Audit Logs 直连可读含 `user.*` 动作、action 筛选、JSON 折叠；下载 403 account_disabled 文案。
- 部署（#5）：`npm run build && wrangler deploy` 后全量 E2E。
