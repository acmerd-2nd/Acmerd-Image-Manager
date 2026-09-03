# Phase 7 · Worker disabled 硬门禁 + 4 个 Admin 端点 — 证据

> 批次：B（Worker 批次） · 执行：软件工程师（寇豆码） · 日期：2026-09-03
> 依据：`docs/phase-7/01-design-gate.md`（D6 修订版）§2 / §6 / §9 / §12(附录 A1–A3)；`docs/phase-0/08-api-contract.md`
> 状态：**D2 硬门禁已全量落地 · D3 契约已实测 · 4 端点已写 · `npx tsc -p tsconfig.worker.json --noEmit` = 0 错误**
> 红线核对：未 git add/commit/push；唯一改动源文件 `worker/index.ts`；未动 `src/`、`supabase/`、其他 worker 文件；未在消息/文档落任何 `.env` 值（密钥全程打码）；未改动 `/api/health`、`/api/admin/storage/delete`、`/api/downloads/*` 的业务语义（仅统一透出 disabled 门禁错误体）。

---

## 0. 产物清单

| 项 | 路径 | 说明 |
| --- | --- | --- |
| 源文件（改动） | `worker/index.ts` | `authenticate()` D2 硬门禁 + `authErrBody()` 统一错误体 + 4 个 admin 端点 + RPC 错误映射 |
| 证据文档 | `docs/phase-7/evidence/worker-endpoints.md` | 本文件 |

---

## 1. D2 硬门禁：`disabled=true` → 每一个 `/api` 请求 `403 {code:'account_disabled'}`

### 1.1 实现方式（只加一个查询点，不改既有端点语义）

`authenticate()` 在原有 `GET /auth/v1/user` 验签之外，**并行**查询：

- `user_roles(role)` —— 角色判定（维持原逻辑）；
- `profiles(id, disabled)` —— **D2 新增查询点**；`disabled === true` 立即返回
  `{ ok:false, status:403, code:'account_disabled', message:'Account disabled' }`。

`requireUser()` / `requireAdmin()` 不做业务改动：鉴权失败时原样透出 `authenticate()` 的 `AuthFail`；
所有既有与新端点统一用新增 `authErrBody(auth)` 渲染响应体，因此：

| 请求者状态 | 任意 `/api` 端点（含 downloads / admin 既有与新端点） |
| --- | --- |
| 未带 / 非法 token | `401 {error:{code:'unauthorized', message:'Invalid or expired token'|'Missing bearer token'|…}}` |
| 角色不足（非 user/admin 或非 admin） | `403 {error:{code:'unauthorized', message:'Login required'|'Admin required'}}` |
| **`profiles.disabled = true`（D2 新增）** | **`403 {error:{code:'account_disabled', message:'Account disabled'}}`** |
| service role key 未配置 | `500` |

改动点核对（6 处 handler 全部经 `authErrBody`）：

- `GET /api/downloads/image/:imageId`（L162）
- `POST /api/downloads/zip`（L205）
- `POST /api/admin/storage/delete`（L522）
- `GET /api/admin/users`（新，L652）
- `POST /api/admin/users/:userId/role`（新，L730）
- `POST /api/admin/users/:userId/disabled`（新，L764）
- `GET /api/admin/stats`（新，L809）

> 既有端点仅把原先硬编码 `{code:'unauthorized',…}` 改为 `authErrBody(auth)`；
> 对非禁用失败场景响应体逐字一致，业务语义零变化。

---

## 2. D3 契约实测（只读探针，无副作用）

用 service-role 直连本 Supabase 实例核实（探针脚本在 `/tmp` 侧，未入库；`.env` 值未回显）：

| # | 探针 | 结果 | 结论 |
| --- | --- | --- | --- |
| 1 | `GET /auth/v1/admin/users?per_page=N&page=M` | 200；envelope `{users:[…], aud}`；header `x-total-count`、`Link`(rel="last") 存在 | 用户列举可用；分页以 `page/per_page` 驱动 |
| 2 | `GET /auth/v1/admin/users/{id}/sessions` | 404（不支持） | 会话列举端点不可用 |
| 3 | `DELETE /auth/v1/admin/users/{id}/sessions/{sid}` | 404（不支持） | 单会话撤销端点不可用 |
| 4 | `POST /auth/v1/admin/users/{random}/logout` | 已注册（随机 id → 404 `user_not_found`） | **可用 best-effort 撤销通道** |
| 5 | `DELETE /auth/v1/admin/users/{id}` | 路由存在（仅记录，不调用） | 未使用 |
| 6 | `POST /rest/v1/rpc/admin_stats`（service-role，零参） | 200；**裸 JSON 对象**，含 7 键 `totalUsers/totalAssets/totalImages/disabledUsers/assetsByStatus/imagesByLanguage/storageUsedBytes` | 统计 RPC 直接透传即可 |
| 7 | `POST /rest/v1/rpc/admin_user_mutation`（随机 actor → FORBIDDEN；真实 actor + 随机 target → TARGET_NOT_FOUND） | 均 HTTP 400，body `{code:"P0001", message:"FORBIDDEN: actor is not an active admin"|"TARGET_NOT_FOUND", details:null, hint:null}` | RPC 异常经 PostgREST 以 **400 + message 短名前缀** 暴露；映射需解析 message |

**裁决 → 代码落地**：

- 禁用后会话撤销走 `POST /auth/v1/admin/users/{id}/logout`，**best-effort**（失败仅 `console.error`，不回滚、不阻塞）。
- `admin_stats`/`admin_user_mutation` 均返回 `jsonb` → PostgREST 裸对象，可直接解析。

---

## 3. 4 个新端点

### 3.1 `GET /api/admin/users`（D1：Auth Admin API 列举 + service-role join）

- 鉴权：`requireAdmin`（已含 D2 未禁用门禁）。
- Query：`?page=`（默认 1）、`?per_page=`（默认 20，上限 100）；非法 → `400 bad_request`。
- 流程：GoTrue `admin/users?page&per_page`（service-role）→ 解析 envelope `{users}` + header `x-total-count` →
  `user_roles?user_id=in.(…)` 与 `profiles?id=in.(…)` 并行 join → 组装。
- 成功 `200`：
```json
{
  "users": [
    { "id": "uuid", "email": "…", "display_name": "…", "role": "user|admin",
      "disabled": false, "created_at": "…", "last_sign_in_at": "…" }
  ],
  "total": 1, "page": 1, "per_page": 20
}
```
- 上游失败（GoTrue/join 非 2xx）：`502 upstream_error`。

### 3.2 `POST /api/admin/users/:userId/role`

- 鉴权：`requireAdmin`。
- Body：`{"role":"user"|"admin"}`；非法 body / 非法 role / 非法 userId → `400 bad_request`。
- 行为：service-role 调 `admin_user_mutation(p_actor=本人, p_target, p_role, p_disabled=null)`（原子 + 审计）。
- 成功 `200`：透传 DB 结果 `{user_id, role, disabled, role_changed, disabled_changed}`。
- 错误映射见 §4。

### 3.3 `POST /api/admin/users/:userId/disabled`

- 鉴权：`requireAdmin`。
- Body：`{"disabled":boolean}`；非布尔 / 非法 userId / 非法 body → `400 bad_request`。
- 行为：
  1. **先**调 `admin_user_mutation(p_actor, p_target, p_role=null, p_disabled)` 原子落库（成功才继续）；
  2. 仅当 `disabled=true`，**再** best-effort `POST /auth/v1/admin/users/{id}/logout`（D3 #4 通道）；
     失败仅日志，**不回滚、不阻塞**。
- 成功 `200`：透传 DB 结果。

### 3.4 `GET /api/admin/stats`（D5 + 约束 4：单一聚合端点）

- 鉴权：`requireAdmin`。
- 行为：一次 service-role `POST /rest/v1/rpc/admin_stats`（`{}` 零参）→ 透传 7 键。
- 成功 `200`：`{totalAssets, assetsByStatus, totalImages, totalUsers, disabledUsers, storageUsedBytes, imagesByLanguage}`。
- 失败：`502 upstream_error`。

---

## 4. RPC 错误 → HTTP 映射（admin_user_mutation）

PostgREST 把 DB `raise exception` 转成 HTTP 400，body `message` 带短名前缀；映射如下：

| DB message 前缀（实测 D3e） | 对外 HTTP | 对外 code | 说明 |
| --- | --- | --- | --- |
| `SELF_DEMOTE_FORBIDDEN` | 403 | `forbidden` | 自降级 |
| `SELF_DISABLE_FORBIDDEN` | 403 | `forbidden` | 自禁用 |
| `FORBIDDEN`（含并发败者，附录 A1） | 403 | `forbidden` | actor 非活跃 admin / 锁内重读失败 |
| `LAST_ADMIN` | 409 | `last_admin` | 变更后无活跃 admin |
| `TARGET_NOT_FOUND` | 404 | `not_found` | 目标用户不存在 |
| 其余非 2xx / 未知 message | 502 | `upstream_error` | 参数错/实例异常，不泄露细节 |

客户端请求体层面（进 RPC 前）：非法 JSON / 非法 role / 非布尔 disabled / 非法 userId → `400 bad_request`。

---

## 5. 类型检查

```text
> npx tsc -p tsconfig.worker.json --noEmit
EXIT=0（无错误）
```

---

## 6. 偏差 / 假设记录（对 QA 与结束报告有约束力）

1. **`GET /api/admin/users` 返回自包含 envelope `{users,total,page,per_page}`**（§6 字面写 `返回 [{…}]`）。
   理由：分页必须把 `total` 交给浏览器端，而响应头需 `Access-Control-Expose-Headers` 才能被前端 fetch 读到；
   改为 JSON envelope 后无需改动共享 CORS 中间件，且与 GoTrue 实例实际 envelope 契约一致（§6 亦要求"分页游标按实例实际契约实施"）。每项字段与 §6 完全一致。
2. **join 缺失 user_roles 行时列表兜底 `role:'user'`**：仅展示层防御（不伪造更高权限），
   真正变更仍由 DB 函数锁内重读裁决，无任何权限放大。
3. **`admin_stats` 直接透传 DB 返回**，key 集合与 §6 完全一致；storage 口径保持"按 DB 记账估算"（D5）。
4. **会话撤销仅走 `/logout`**（D3 #4）；`/sessions*` 在本实例 404，未使用。
5. **未做线上 Worker HTTP 冒烟**：生产 Worker 尚未部署本批代码（部署属任务 #5）。
   本批证据边界 = D3 直连只读探针 + tsc 0 错误 + 代码评审；真实 HTTP 行为由任务 #4（QA 套件）与 #5（部署 + E2E）覆盖。

---

## 7. 遗留 / 交接

- 前端任务（#3）将消费：users envelope（`users/total/page/per_page`）、mutation 结果（`role_changed/disabled_changed`）、
  `account_disabled`（403）、`last_admin`（409）、`forbidden`（403）错误码。
- QA（#4）建议用例：disabled 门禁全端点矩阵、self-demote/self-disable（403）、LAST_ADMIN（409）、
  TARGET_NOT_FOUND（404）、并发交叉互禁败者 FORBIDDEN（403）、用户列表 join 正确性、stats 7 键。
