# 08 · API Contract

两条通道：**Supabase 直连**（读 + admin 常规写，RLS 保护，不在此列接口）与 **Worker API**（本文件定义）。

## 约定

- Base：`https://image.acmerd.com/api`
- 鉴权：`Authorization: Bearer <supabase_jwt>`；需要 USER 的接口对 GUEST 返回 `401`，USER 调 ADMIN 接口返回 `403`。
- 错误体统一：`{ "error": { "code": string, "message": string } }`
- Worker 内部用 `SUPABASE_SERVICE_ROLE_KEY`（绑定 Secret），绝不下发。

## 公共接口

### GET /api/health
- 鉴权：无。返回 `200 { "status": "ok", "time": iso }`。

## 下载接口（需 USER / ADMIN）

### GET /api/downloads/image/:imageId
- 鉴权：Bearer JWT；校验角色 ∈ {user, admin}；校验目标图片所属 asset = published（service role 查询）。
- 行为：校验通过 → `302` 重定向到该对象 public URL（`Content-Disposition: attachment` 场景由前端以 `download` 属性或 Worker 补 header 实现）。
- 错误：`401` 未登录；`403` 角色不足；`404` 图片不存在或未发布；`500` 存储异常。

### POST /api/downloads/zip
- 鉴权：Bearer JWT + 角色 ∈ {user, admin}。
- 请求体：
```json
{ "assetLanguageId": "uuid", "imageIds": ["uuid", "..."] }
```
- 服务端校验：
  1. `imageIds` 均属于 `assetLanguageId` 且其 asset published；
  2. `imageIds.length` ≤ `MAX_ZIP_IMAGES`（默认 **30**）；
  3. 总 `file_size` ≤ `MAX_ZIP_BYTES`（默认 **200 MB**）。
- 超限：`413 { "error": { "code": "zip_limit_exceeded", "message": "Too many images selected. Please download in smaller batches." } }`
- 成功：`200`，`Content-Type: application/zip`，`Content-Disposition: attachment; filename="{asset-slug}-{lang}.zip"`，**流式**返回（store 模式打包，Workers CPU/时长限制内）。
- 下载响应带 `Downloaded-At` 处理：V1 不做下载次数统计（不在需求内）。

## Admin 接口（需 ADMIN，全部写 audit_logs）

### POST /api/admin/users/:userId/role
- 请求体：`{ "role": "user" | "admin" }`
- 行为：service role 更新 `user_roles`；写 audit `user.role_changed`（metadata 记录 from/to）。
- 错误：`400` 非法 role；`403` 非 admin；`404` 用户不存在；`409` 目标是最后一名 admin 时拒绝降级（防锁死）。

### POST /api/admin/users/:userId/disabled
- 请求体：`{ "disabled": true | false }`
- 行为：service role 更新 `profiles.disabled`；`true` 时同时按需调用 Supabase Admin API 使其 session 失效；写 audit `user.disabled` / `user.enabled`。
- 登录侧约束：登录成功回调/中间件检查 `disabled` → 拒绝（提示联系管理员）。

### GET /api/admin/stats
- 返回：`{ "totalAssets": n, "publishedAssets": n, "totalImages": n, "totalUsers": n, "storageUsedBytes": n }`（service role 聚合查询）。

### GET /api/admin/storage
- 返回：`{ "totalQuotaBytes": n|null, "usedBytes": n, "imageCount": n, "byLanguage": {...} }`。

### GET /api/admin/audit-logs?limit=&offset=&action=&actor=
- 返回分页 audit_logs（admin 也可经 RLS 直连查询；此接口供 Worker 侧统一分页，二选一实现，默认直连 RLS）。

## Supabase 直连通道（非 Worker，但列入 Contract 便于统一）

| 操作 | 表/视图 | 鉴权 |
| --- | --- | --- |
| Asset Card 列表/搜索/筛选 | `published_assets` 视图 + `tags` | anon（RLS） |
| Asset 详情（含 published 语言） | `assets` + `asset_languages` + `images` + `download_sources` | anon / user |
| Admin Asset CRUD、语言管理、图片排序、Cover、Tag 关联、Download Source | 对应表 | admin JWT（RLS is_admin） |
| Admin Tag CRUD | `tags` | admin JWT |
| 用户列表 | `profiles` + `user_roles` | admin JWT（RLS select all） |
| 审计查询 | `audit_logs` | admin JWT |

## 限流 / 防护

- ZIP 接口：每 IP 每 10 分钟 ≤ 10 次（Worker 内存/DO 计数，V1 简化为尽力而为）。
- 所有 Worker 接口带 `CORS`：仅允许 `https://image.acmerd.com` 与本地开发源。
