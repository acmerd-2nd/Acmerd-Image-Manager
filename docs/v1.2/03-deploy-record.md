# V1.2 生产部署记录（2026-09-07）

> **授权**: Owner 2026-09-07 明示"允许生产部署"（chat 授权）
> **范围**: V1.2 A/B/C 三项代码 + 0016 迁移（C 的邮件闭环验证与 SMTP 另行推进）

## 1. 部署前证据

| 项 | 结果 |
| --- | --- |
| 0015 隔离库冒烟（A 多层 Folder） | ✅ 13/13（H1–H9；曾抓出守卫 2 个真 bug 已修） |
| 0015 生产应用 + 核验 | ✅ 2026-09-07 早间（parent_id/触发器/视图重建/零副作用） |
| 0016 隔离库冒烟（B Schedule） | ✅ 10/10（S1–S8；S4b/S6a 为测试脚本口径 bug，修正后全绿） |
| Worker 本地沙箱（A 集成层） | ✅ 13/13（W1–W7，e2e7 零残留） |
| C 页面沙箱走查（本地 preview + 真浏览器） | ✅ 4 项（抓出并修复 auth.backToLogin 缺失） |
| typecheck（前端+Worker） / vite build | ✅ 0 错误 / ✅ |

## 2. 执行记录

- **[x] 授权方式**: chat 明示授权（2026-09-07）
- **[x] 0016 生产迁移**: `node scripts/db-apply.mjs` → `apply 0016_schedule_items.sql ... OK`（0001–0015 全 skip）
- **[x] 生产迁移核验**: table=1 / policies=4 / published_schedule_items 视图在位 / allowlist 含 schedule.* 5 项 / items=0
- **[x] 部署前 version（回滚锚点）**: `71278568`（V1.1 生产版）
- **[x] 部署**: wrangler deploy（本地二进制）→ 33 assets + Worker 上传成功；routes 列表步骤报已知 cosmetic 10000（token 缺 zone routes 读权限，不影响自定义域绑定）
- **[x] 部署后 version**: **`3fd18445-7f81-4588-8c73-fb2a1b24c350`**（number 34，2026-09-07T03:01:12Z）
- **[x] 部署后 bundle**: `index-CGRO1bD2.js`（含 AdminSchedulePage chunk，线上 200）
- **[ ] 回滚预案未触发**

## 3. 线上验证

| # | 项 | 结果 |
| --- | --- | --- |
| V1 | `/api/health` | ✅ 200 |
| V2 | 判别器：`GET /api/admin/schedule-items` 无 token | ✅ 401 `{"error":{"code":"unauthorized"}}`（新 Worker 已生效） |
| V3 | 新 bundle 上线 | ✅ `index-CGRO1bD2.js` |
| V4 | anon 直读 `published_schedule_items`（PostgREST） | ✅ 200 `[]`（空集正确） |
| V5 | e2e7 生产 CRUD 闭环 | ✅ 6/6：创建草稿 → 列表 → 发布 → anon 公开视图可见 → 删除 → **零残留** |
| V6 | 浏览器：`/schedule` | ✅ 空态 Coming Soon（D7 与导航开关解耦语义保持） |
| V7 | 浏览器：`/reset-password` | ✅ 渲染 + 「返回登录」i18n 正常 |
| V8 | 浏览器：首页 | ✅ 资产卡正常（零回归） |

## 4. 已知边界（不阻断）

- **C 密码找回的邮件闭环未验证**：demo 种子邮箱非真实可收信邮箱；且内置 mailer 限速 ~2 封/小时。D10 ①②（Site URL + redirect allowlist）Owner 已配好，③ SMTP 后补。生产 `/reset-password/confirm` 路由现已随新 bundle 就位，邮件链接落点已有效。
- 0009–0014 在 `schema_migrations` 中原无记录（V1.1 期间经其他通道应用）；2026-09-07 跑 migrator 时被幂等重放并补记，已核验零副作用。
- wrangler routes cosmetic 10000（运维项，同 V1.1）。

## 5. 遗留待办

- Owner：D10③ SMTP（正式开放后建议配 Custom SMTP）
- Owner：CDN 终裁（docs/v1.2/02：jsDelivr 已退出 gh CDN，建议维持 raw）
- Agent：V1.2 收口报告 + HANDOVER 刷新（随 V1.2 全项 CLOSED 时）
- 可选：生产 `registration_enabled` 默认关闭（Admin 一键）
