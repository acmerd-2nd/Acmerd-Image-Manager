# 07 · Route Map

## 用户端（React Router，App Shell 布局：顶部导航 + 内容区）

| 路由 | 页面 | 访问控制 | 说明 |
| --- | --- | --- | --- |
| `/` | Explore 首页 | 公开 | Asset Library 视觉首页，Featured / Recent / Asset Grid |
| `/explore` | 同 `/`（重定向到 `/` 或共用组件） | 公开 | 保留独立路径供导航 |
| `/search?q=&tags=` | 搜索结果 | 公开 | Query + Tag 筛选，结果为 Asset Card |
| `/asset/:slug` | Asset 详情 | 公开（内容受 RLS） | 用 slug；内部仍可按 id 兜底 |
| `/image/:id` | 图片详情/Lightbox 路由 | 公开查看，下载按钮按角色 | 挂在 Asset 详情内的 Lightbox 模式 |
| `/login` | 登录 | 公开（已登录→跳 `/`） | |
| `/register` | 注册 | 公开（已登录→跳 `/`） | |
| `/profile` | 个人资料 | 登录用户（USER+） | display_name / avatar |
| `*` | 404 | 公开 | |

## 管理端（AdminLayout：侧边栏 + 内容区，整体挂 Route Guard）

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/admin` | Dashboard 重定向 → `/admin/dashboard` | |
| `/admin/dashboard` | 总览 | Total Assets / Images / Users / Storage Used + Recent |
| `/admin/assets` | Asset 列表 | Cover/Name/Images/Languages/Tags/Status/Updated/Actions；搜索+状态筛选 |
| `/admin/assets/new` | 新建 Asset | Name/Description/Cover/Tags → 语言版本 → 上传 → 排序 → 下载源 → 发布 |
| `/admin/assets/:id` | 编辑 Asset | 同上，含语言管理面板 |
| `/admin/users` | 用户管理 | 角色/禁用（经 Worker API） |
| `/admin/tags` | Tag 管理 | Create / Rename / Delete |
| `/admin/storage` | Storage 用量 | Total/Used/Image Count（V1 只读） |
| `/admin/audit-logs` | 审计日志 | Actor/Action/Target/Time/Metadata，按时间倒序分页 |
| `/admin/settings` | 设置 | V1 占位（站点信息等） |

## Route Guard 设计

```plaintext
<RequireRole allow={['admin']}>
  └─ 包裹全部 /admin/*
     ├─ 会话加载中 → 全屏 Spinner
     ├─ 未登录   → redirect /login?next=/admin/...
     ├─ USER     → 403 页（不泄露 Admin 结构）
     └─ ADMIN    → 渲染
<RequireAuth>  └─ 包裹 /profile
<RedirectIfAuthed> └─ 包裹 /login /register
```

- Guard 数据源：`user_roles` 中当前用户的 role（RLS 只允许看自己），Session 恢复后并行拉取并缓存（TanStack Query，staleTime 5min，登出即清）。
- Worker 侧兜底：SPA 是单页应用，`/admin/*` 物理上仍返回 index.html，但所有 `/admin` 数据接口由 RLS/Worker 二次拦截；深链访问 `/admin` 对 USER 呈现 403 由前端完成（V1 接受此层为 UX 层）。

## 导航可见性

```plaintext
GUEST:  Explore | Search            [Login] [Register]
USER:   Explore | Search            [Profile] [Logout]
ADMIN:  Explore | Search | Admin    [Profile] [Logout]
```
