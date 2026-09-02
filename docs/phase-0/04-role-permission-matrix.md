# 04 · Role & Permission Matrix

角色：GUEST（未登录）/ USER（普通登录用户）/ ADMIN。

原则：**隐藏按钮 ≠ 权限控制**。每一行都标注真正的执行层；执行层缺失的设计不允许上线。

## 功能权限矩阵

| 能力 | GUEST | USER | ADMIN | 真正执行层 |
| --- | :-: | :-: | :-: | --- |
| 浏览已发布 Asset | ✅ | ✅ | ✅ | RLS（published 过滤） |
| 搜索 / Tag 筛选 | ✅ | ✅ | ✅ | RLS |
| 查看详情 / 切换语言 | ✅ | ✅ | ✅ | RLS（language published 过滤） |
| 查看图片（浏览） | ✅ | ✅ | ✅ | Storage public read |
| 单图下载 | ❌ | ✅ | ✅ | Worker `/api/downloads/image/:id` 校验 JWT |
| 多选 ZIP 下载 | ❌ | ✅ | ✅ | Worker `/api/downloads/zip` 校验 JWT |
| Package Download（网盘跳转） | ❌ | ✅ | ✅ | 前端 UI Guard + 页面路由守卫* |
| 注册 / 登录 | ✅ | — | — | Supabase Auth |
| 创建 / 编辑 / 删除 / 归档 Asset | ❌ | ❌ | ✅ | RLS（assets 写策略 is_admin） |
| 上传 / 删除 / 排序图片 | ❌ | ❌ | ✅ | Storage Policy + RLS（images 写策略） |
| 设置 Cover | ❌ | ❌ | ✅ | RLS（assets update） |
| 语言版本 draft/published | ❌ | ❌ | ✅ | RLS（asset_languages 写策略） |
| Tag 增删改 / Asset 打 Tag | ❌ | ❌ | ✅ | RLS（tags / asset_tags 写策略） |
| Download Source 管理 | ❌ | ❌ | ✅ | RLS（download_sources 写策略） |
| Publish / Unpublish | ❌ | ❌ | ✅ | RLS（assets / asset_languages update） |
| 查看用户列表 / 改角色 / 禁用 | ❌ | ❌ | ✅ | Worker Admin API（service role）+ Audit |
| Dashboard 统计 / Storage 用量 | ❌ | ❌ | ✅ | Worker Admin API |
| 查看 Audit Logs | ❌ | ❌ | ✅ | RLS（audit_logs select is_admin） |
| 进入 `/admin/*` 路由 | ❌ | ❌ | ✅ | 前端 Route Guard + Worker 静态路由兜底 |

\* Package Download 本质是打开外部网盘链接，链接本身经 RLS 仅对登录用户返回（见 05），前端再做一层登录提示。

## 明确禁止项（写死在各层）

| 行为 | 禁止方式 |
| --- | --- |
| USER 手动访问 `/admin` | Route Guard → 重定向 403 页 |
| USER 调用 `/api/admin/*` | Worker 校验 JWT + `is_admin()` → 403 |
| USER 直连 Supabase INSERT/UPDATE/DELETE 任何业务表 | RLS 无写策略 → 默认拒绝 |
| USER 直连 Storage 上传 | Storage Policy 仅 admin write → 拒绝 |
| USER 给自己提权 admin | `user_roles` 无任何客户端写策略（admin 也只能经 Worker 改） |
| GUEST 下载 | Worker 校验 JWT，无 token → 401 |
| ADMIN 身份用邮箱硬编码判断 | 一律 `user_roles.role` + `is_admin()` |

## 角色判定数据流

```plaintext
登录 → JWT
  ├─ 前端：查询 user_roles（RLS: 只能看自己的行）→ 得到 role → UI 导航/Route Guard
  ├─ Worker：verify JWT → 查 user_roles（service role）→ API 鉴权
  └─ RLS：auth.uid() + is_admin()
```

ADMIN 是加在 USER 之上的能力叠加（ADMIN 拥有 USER 全部能力）。
