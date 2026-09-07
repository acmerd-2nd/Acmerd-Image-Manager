# V1.2 收口报告（Closure Report）

> **日期**: 2026-09-07 · **依据**: docs/v1.2/01 Design Gate（D1–D12 Owner 2026-09-07 全批）
> **状态**: **A/B/C/D 全部 CLOSED**（D12 终裁：维持 raw）；生产已部署并验证
> **生产形态**: ver `3fd18445`（bundle `index-CGRO1bD2.js`）· 迁移 0001–0016 全 applied · 回滚锚点 `71278568`

---

## 一、Implemented（按 Gate §5 顺序）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| **A 多层 Folder** | 0015（parent_id 自引用 FK RESTRICT + 守卫触发器：自引用/环/深度≤5/子树随迁溢出 + `published_collections` 递归链重建）· Worker create/patch `parentId` + 删父预检 409 + guard 错误映射 · Admin 树形渲染 + 父级选择器（排除自身+子孙）· 首页仅根级 · 详情页面包屑 + 子合集卡 | ✅ CLOSED |
| **B Schedule 编排** | 0016（schedule_items + 4 条 RLS 镜像 0012 + `published_schedule_items` 视图 + 审计 5 动作 + allowlist 38→43）· Worker `/api/admin/schedule-items` CRUD · AdminSchedulePage（含路由/侧栏）· 公开 SchedulePage 真实渲染（空态回 Coming Soon） | ✅ CLOSED |
| **C 密码找回** | `/reset-password` + `/reset-password/confirm`（GoTrue 原生流 D9，redirectTo 仅同源常量）· 登录页「忘记密码？」入口 · confirm 页无 recovery session 自动弹回 · 改密成功撤销会话回登录页 | ✅ CLOSED（邮件闭环验证 Owner 明示暂缓） |
| **D R1 CDN 评估** | jsDelivr @main 三项实测：**gh/ 面已整体 301 → raw.githubusercontent.com（连 jquery@tag 也如此）**，npm 面正常 → 零加速收益 | ✅ **CLOSED（Owner 2026-09-07 终裁：维持 raw，R1 关闭）** |

## 二、Files（变更足迹）

- **迁移**：`supabase/migrations/0015_collection_hierarchy.sql`、`0016_schedule_items.sql`
- **Worker**：`worker/index.ts`（collections parentId 接线；schedule-items CRUD；+245 行）
- **前端**：`src/features/collections/api.ts`、`src/features/schedule/api.ts`（新）、`AdminCollectionsPage`（树形）、`AdminSchedulePage`（新）、`SchedulePage`、`HomePage`、`CollectionDetailPage`、`ResetPasswordPage`（新）、`ResetPasswordConfirmPage`（新）、`LoginPage`、`AdminLayout`、`App.tsx`、`types/database.ts`、`i18n/zh.ts`、`i18n/en.ts`
- **脚本**：`scripts/v12-a-folder-smoke.mjs`、`v12-a-worker-sandbox.mjs`、`v12-b-schedule-smoke.mjs`
- **文档**：`docs/v1.2/01-design-gate.md`、`02-cdn-evaluation.md`、`03-deploy-record.md`、本报告
- **commit 链**：`483299b → 35f9c10 → 7d92c2c → 94b1d56 → 1192dea → 189177d → 59133ae → 8afcde9`（远端 main 同步）

## 三、Database

- 0001–0016 全 applied（0015/0016 本次新增；0016 生产核验：表 + 4 RLS + 视图 + allowlist 43 + 零存量影响）
- **事实更正留档**：0009–0014 在 `schema_migrations` 原无记录（V1.1 期间经其他通道应用）；2026-09-07 migrator 幂等重放并补记，核验零副作用
- 冻结不变量零触碰：published_assets / is_admin() / RLS 结构 / 两层可见性 / Credits 三态 / `makeImageUrl` 唯一出口 / `/asset/:slug` 与 `/collection/:slug` URL 语义 / Storage 原件

## 四、Tests（证据链）

| 证据 | 结果 |
| --- | --- |
| 0015 隔离库冒烟（H1–H9） | **13/13**（抓出守卫 2 个真 bug：深度阈值 off-by-one、子树高度重复计 +1——均已修后全绿） |
| 0016 隔离库冒烟（S1–S8） | **10/10**（S4b/S6a 为测试脚本口径 bug 修正；审计 5 动作真实提交验证） |
| Worker 本地沙箱（W1–W7） | **13/13**（e2e7 前缀零残留） |
| C 页面沙箱走查（真浏览器） | **4/4**（登录入口/请求页提交闭环/confirm 守卫弹回/i18n；抓出并修复 `auth.backToLogin` 缺失） |
| 生产线上验证（V1–V8） | **全绿**：判别器 401 JSON · e2e7 生产 CRUD **6/6 零残留** · `/schedule` 空态 · `/reset-password` 渲染 · 首页零回归 |
| typecheck / build | 前端+Worker 0 错误；vite build 绿 |

## 五、Security

- **零新增 Secret**；Service Role 仅 Worker Secret/本地脚本；凭据未进 Git/chat/文档
- schedule_items：客户端基表零 grant（0002 default privilege 模型），公开只读经视图 + `security_invoker` RLS；写仅 service_role（Worker 持有）
- collections 层级：防环/深度终审在 DB 触发器（无法被 API 层绕过）；删父 RESTRICT + Worker 友好预检双保险
- 密码找回：邮箱所有权即授权边界（与登录同级）；redirectTo 常量白名单；D11 审计盲区（不落 audit_logs）按 Gate 接受并留档
- 审计 allowlist 38→43 严格超集；Worker 直写 `schedule.item_*` 与 DB 触发器语义对齐（status 变更记 published/archived）

## 六、Owner 待裁/待办

1. **邮件闭环验证**（暂缓，Owner 明示）：需真实收信邮箱；SMTP（D10③）可选后补，内置 mailer 限速 ~2 封/小时
2. 可选：生产 `registration_enabled` 默认关闭（Admin 一键）
3. 已归档：D12 CDN 终裁（2026-09-07「维持 raw」，R1 关闭，见 docs/v1.2/02 终裁注记）

## 七、Gate Status

| Gate | 裁决 | 状态 |
| --- | --- | --- |
| V1.2 Design Gate（D1–D12） | Owner 2026-09-07 全批"按建议" | ✅ APPROVED |
| A 多层 Folder | 证据全 CONFIRMED | ✅ **PASS / CLOSED** |
| B Schedule | 证据全 CONFIRMED（含生产 e2e） | ✅ **PASS / CLOSED** |
| C 密码找回 | 代码链证据 CONFIRMED；邮件 E2E 暂缓（Owner 明示） | ✅ **PASS（暂缓项已留档）** |
| D CDN | Owner 终裁「维持 raw」（2026-09-07） | ✅ **PASS / CLOSED（R1 关闭）** |
