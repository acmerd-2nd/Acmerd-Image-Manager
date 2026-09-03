# Phase 7 · Admin Platform Consolidation — QA 独立证据验证报告（Gate G7 输入）

> 角色：QA 工程师（严过关）· fresh-eyes 独立验证（未参与实现，不引用实现者证据为结论来源）
> 日期：2026-09-03 · 依据：`docs/phase-7/01-design-gate.md`（D6 修订版 §4.5/§5/§6/§7/§9/§10/§12 A1–A5）
> 范围：A 隔离库冒烟 / B 权限矩阵 / C Phase2–6 不变量回归 / D is_admin / E Worker 静态安全审查 / F 前端静态审查 / G 构建
> 红线核对：无 git 操作；未改动任何源文件/migration/src/worker；未在生产库建/删/改任何真实行；`.env` 值全程未落盘或回显（连接一律打码）；隔离库已全部 DROP。

---

## 0. 执行方式（独立复跑，非引用）

- 环境：生产集群角色 `postgres`（rolcreatedb=true、rolbypassrls=true、成员 anon/authenticated/service_role/authenticator），PG 17.6，与批次 A 相同的直接会话连接。
- 隔离库：一次性 `acmerd_phase7_qa_<rand>`（多库轮换），建极简 `auth`/`storage` 桩 + RLS 使能 + 角色授权（镜像 Supabase，含 `auth.uid()` 读 `request.jwt.claim.sub` GUC），**按文件名序应用 0001→0006**（多语句，对齐 `scripts/db-apply.mjs`）。
- 夹具：A/B=活跃 admin、U/C=普通 user、R=临时用户、X=无 profile 的 admin（LAST_ADMIN 负样本专用）；资产 alpha(published, en+de, 3 图)、draft-only(draft)。测试内数据随库销毁，无残留。
- 对照库：`acmerd_phase7_qa_pre_<rand>` 只应用 **0001→0005**（不含 0006），证明 pre-existing 缺陷。
- 结果：DB 套件 **31/31 PASS**；对照基线 4 项 3 项 PASS + 1 项复现既有缺陷；E/F 静态 PASS；G 0 错误。

---

## 1. 执行矩阵与关键摘录

### A. 隔离库冒烟复验（全部 PASS，16/16）

| # | 场景 | 结果 | 关键摘录 |
| --- | --- | --- | --- |
| A1 | 唯一 admin 自降级 | PASS | `SELF_DEMOTE_FORBIDDEN: self-demote is not allowed`；A 仍活跃 |
| A2 | 唯一 admin 自禁用 | PASS | `SELF_DISABLE_FORBIDDEN: self-disable is not allowed` |
| A3 | user 降级唯一 admin | PASS | `FORBIDDEN: actor is not an active admin`；A 未被改动 |
| A4 | 2 活跃 admin：A 禁 B | PASS | 放行；B role=admin+disabled=true；活跃 admin=1；审计 `user.disabled` actor=A target=B，metadata disabled_from:false→to:true 含 actor |
| A5 | **并发交叉互禁**（双 pg.Client） | PASS | **恰一成功（A→disable B）、败者（B→disable A）`FORBIDDEN`**；并发后活跃 admin=1（绝无归零）；A1 语义裁决与实现一致 |
| A6 | 禁 B 后 A 再自禁 | PASS | `SELF_DISABLE_FORBIDDEN` |
| A7 | A 禁普通 user U | PASS | 放行 + 审计 `user.disabled`；活跃 admin 仍 2 |
| A8 | 被禁 admin 直连改 assets/上传 | PASS | draft SELECT=0 行；INSERT assets/storage.objects → `new row violates row-level security`；UPDATE assets/storage.objects=0 行；对照组活跃 admin A UPDATE=1 / storage insert=1 |
| A9 | 被禁 admin 自助解禁 | PASS | `CHANGING_DISABLED_REQUIRES_ADMIN`；B 仍 disabled=true（禁止自愈） |
| A10 | B 启用 A（A 已禁） | PASS | 放行 + 审计 `user.enabled` actor=B；A 恢复（UPDATE assets=1 行） |
| A11 | 白名单外 action 直插 | PASS | `violates check constraint "audit_logs_action_allowlist"`；allowlist 内 action 可写 |
| A12 | 每次变更审计齐全 | PASS | role_changed×2 + user.disabled + user.enabled；均含 actor+role_from/to+disabled_from/to，target_type='profiles' |
| XA | 同值 no-op 跳审计 | PASS | 重复禁已禁 U：`disabled_changed=false`，审计 1→1 不增 |
| XB | **LAST_ADMIN 负样本** | PASS | actor=X（无 profile 的 admin，左连通过/普查内连不计）disable 唯一活跃 admin A → `LAST_ADMIN: operation would leave no active admin` |
| XC | 普查子查询语义 | PASS | 唯一活跃 admin → census_zero=true；两活跃 → false |
| XD | admin_stats() 口径 | PASS | service_role 可执行；7 键齐全；`storageUsedBytes=3500 / totalImages=3 / imagesByLanguage.en=2,de=1` |

### B. 权限矩阵（全部 PASS，7/7）

| # | 场景 | 结果 | 摘录 |
| --- | --- | --- | --- |
| B1 | authenticated 写 user_roles（insert/update） | PASS | `permission denied for table user_roles`（GRANT 仅 service_role） |
| B2 | authenticated 写 audit_logs | PASS | `permission denied for table audit_logs`（GRANT/RLS 均无写） |
| B3 | anon/authenticated 拒执行 mutation+stats；service_role 可 | PASS | anon/authenticated → `permission denied for function admin_user_mutation/admin_stats`；service_role → 正常返回 |
| B4 | 活跃 admin authenticated 直连改他人 profiles.disabled | PASS | **0 行**（0001 profiles UPDATE 策略仅本人行 → A5 安全闭包成立；他人 disabled 唯一可写通道 = service_role RPC） |
| B5 | 活跃 admin 自禁（authenticated 直连） | PASS | `SELF_DISABLE_FORBIDDEN`（RLS 本人行可见 + 触发器第一支） |
| B6 | 被禁 admin 自助解禁 | PASS | `CHANGING_DISABLED_REQUIRES_ADMIN`（is_admin 含 disabled=false → 第二支拒） |
| B7 | 被禁 admin 改 assets（select draft/insert/update） | PASS | draft 不可见；INSERT → RLS 拒；UPDATE=0 行 |

### C. Phase 2–6 不变量回归（0001–0005 对应；全部 PASS，6/6 + 1 既有缺陷复现）

| # | 证据（迁移标注） | 结果 | 摘录 |
| --- | --- | --- | --- |
| C1 | 普通 user 仅见 published assets/自己的行（Phase2·0001/0002） | PASS | assets 仅 alpha(published)；profiles/user_roles 仅自己行；images 仅 published 语言 |
| C2 | 非 admin 建 tag/改 download_source 被拒（Phase2·0001/0002） | PASS | insert tags → RLS 拒；update download_sources=0 行 |
| C3 | download_source.url 非法值被 guard 拒（Phase5·0004） | PASS | `http://pan.quark.cn/x` 与 `https://pan.quark.cn.evil.com/x`（子串域）均 `DOWNLOAD_URL_INVALID`；合法 `https://pan.quark.cn/s/abc` 放行 |
| C4 | 资产/图片/tag 审计触发器照常落库且 ∈ allowlist（Phase3/6·0001/0003/0005） | PASS | distinct actions：asset.created/deleted/published、asset.tag_added/removed、download_source.updated、image.uploaded/deleted、tag.created/deleted —— 全部 ∈ 18 项 allowlist |
| C4-obs | tag UPDATE 触发 0001 缺陷（pre-existing） | PASS(复现) | `record "new" has no field "updated_at"`；0001–0005 对照库同样复现 → **非 0006 引入**（见 §3 DEF-1） |
| C5 | search/tags 函数可用（Phase6·0005） | PASS | `search_assets('alpha')`=alpha；tag='landscape' 命中；无条件=全部 published；>200 字符 → `QUERY_TOO_LONG` |
| C6 | storage 上传/删除仅 admin（Phase2·0001） | PASS | U insert → RLS 拒、delete=0 行；A insert=1 行 |

> Phase 4 无独立 DB migration（其 DB 面 = 0001 的 images/asset_languages/download_sources RLS），上述 C1/C6 已覆盖其"published 双层可见性"DB 不变量；Worker 下载通道静态审查见 §E。

### D. is_admin 语义（PASS，1/1）

| 场景 | 结果 | 摘录 |
| --- | --- | --- |
| 活跃 admin / 被禁 admin / 普通 user | PASS | A=true（sub=A）、B=false（sub=B 且 disabled=true）、U=false（sub=U）——`is_admin()` = role='admin' AND profiles.disabled=false 成立 |

### E. Worker 静态安全审查（fresh-eyes，不跑线上）—— PASS（2 条小注）

- **D2 门禁全量覆盖**：全部需鉴权 `/api` handler（downloads image/zip、storage/delete、users、role、disabled、stats 共 7 处）均经 `authenticate()`；`disabled=true` → `403 {code:'account_disabled'}` 在 requireUser/requireAdmin 之前返回。唯一无鉴权为 `/api/health`（公开、无用户数据，符合契约）；`app.notFound`/`app.all('*')` 不构成 /api 数据通道。
- **RPC 传参与 null 语义**：`callUserMutation` 统一传 `{p_actor,p_target,p_role,p_disabled}`，role 端点 `(role, null)`、disabled 端点 `(null, boolean)`；JSON null → SQL NULL → 函数内 `coalesce` 视为"不变"，语义正确。
- **注入面**：`userId` 路由参数一律先过 `UUID_RE`（role/disabled/stats/users 列表均校验）再进 RPC/URL；GoTrue join `inList` 由服务端返回 uuid 组成；`page/per_page` 以 `/^\d+$/` 白名单；无 SQL 拼接注入点。
- **错误映射与 A4 一致**：`SELF_DEMOTE/SELF_DISABLE/FORBIDDEN → 403 forbidden`、`LAST_ADMIN → 409 last_admin`、`TARGET_NOT_FOUND → 404 not_found`、其余 → `502 upstream_error`；请求体/role/disabled/userId 非法 → `400 bad_request`。
- **/logout best-effort 真正非阻塞**：先原子落库（`mut.ok` 才继续）→ 仅 disabled=true 才发起 `POST /auth/v1/admin/users/{id}/logout` → 整段包在 try/catch，覆盖非 2xx（`console.error`）与抛异常（`catch`）两条失败路径，**无任何 throw 逃逸到响应**；不回滚、不阻塞。
- **既有端点语义**：downloads/storage/delete 仅把错误体改为经 `authErrBody` 渲染，非禁用失败场景响应逐字一致，业务逻辑零改动。
- 小注 E-1（cosmetic）：`authenticate` 对角色/档案查询上游失败返回 `500` 但 `authErrBody` 默认 code 为 `'unauthorized'`（`auth.code ?? 'unauthorized'`）——状态 500 + code unauthorized 略误导，非安全问题。
- 小注 E-2：`/auth/v1/user` 与角色/档案查询串行依赖（先验签再并行取角色+disabled）——非并行，属可接受实现；无安全影响。

### F. 前端静态审查 —— PASS

- **单 stats 端点**：`getAdminStats()` 仅定义于 `features/admin/api.ts`，唯一调用点 = Dashboard（reload）与 Storage（reload）各 **一次**，无循环/多处拼装（grep 实证）；Users 页走 `listAdminUsers`。
- **Audit 页 = admin JWT 直连**：`AdminAuditLogsPage` 用 `supabase.from('audit_logs').select('*').order(created_at desc).like(action, 前缀).range(...)`，actor 名经 RLS 直连 profiles 解析——**未走 Worker 读端点**（D4 遵守）。
- **Settings 全清**：App.tsx 无 settings 路由/引用；AdminLayout 侧栏 = Dashboard/Assets/Users/Tags/Storage/Audit Logs 六项；文件无 `AdminPlaceholderPages`；grep `settings|Settings|Placeholder` 仅命中各输入框 `placeholder=` HTML 属性（无关）。
- **AuthProvider disabled 折叠**：role 与本人 disabled 并行查询；disabled=true → 生效 `role='user'` + `isDisabled/disabled` 暴露 + `isAdmin=false`（守卫即拒），只动身份/守卫层，不构建任何业务查询；业务通道仍走 supabase RLS / Worker。
- **错误码→中文**：`account_disabled/last_admin/forbidden/not_found/bad_request/unauthorized/upstream_error` 全覆盖（api.ts `toUserMessage`）；用户端 downloads/api 单图+ZIP 均有 `account_disabled → 账号已被禁用，请联系管理员`（grep 实证）。

### G. 构建复跑 —— PASS

```
npm run typecheck → tsc -p tsconfig.json && tsc -p tsconfig.worker.json → EXIT=0
npm run build     → vite build → 1679 modules → EXIT=0
                   dist/assets/index-*.js 505.46 kB（>500 kB 为既有体积警告，非错误）
```

---

## 2. 隔离库清理确认

- `acmerd_phase7_qa_mtlkdvt25bk0ie`、`acmerd_phase7_qa_mtlkpb62uq94q6`、`acmerd_phase7_qa_mtlkv4xq0ywul6`、`acmerd_phase7_qa_pre_*`（对照）均已 `DROP ... WITH (FORCE)`。
- 终态扫描：`SELECT datname ... like 'acmerd_phase7%' / 'acmerd_qa%'` → **REMAINING []**。
- 生产库仅执行只读查询（schema/列/触发器/审计存量核对），未创建/删除/修改任何真实用户或行。

---

## 3. 发现缺陷（供 team-lead 仲裁；均未改动代码）

### DEF-1（pre-existing · 中 · 非 Phase 7 回归，建议排期修复）
- **文件：行**：`supabase/migrations/0001_initial_schema.sql` — `tags` 表（约 L131–136）无 `updated_at` 列，但 L165 安装 `touch_tags_upd ... execute touch_updated_at()`（函数体 `new.updated_at = now()`）。
- **复现**：任何 `UPDATE public.tags ...` → `record "new" has no field "updated_at"`（PG 在 BEFORE UPDATE 触发器求值 new.updated_at 时报错）。
- **证据链**：① 隔离库 0001–0006 复现；② **0001–0005 对照库复现（证明先于 Phase 7 存在）**；③ 生产只读核对：`tags` 列 = id/name/slug/created_at（无 updated_at），且 trigger `touch_tags_upd` 存在 → **生产现状同样受影响**。
- **实际影响**：AdminTagsPage `renameTag`（src/features/tags/api.ts L23–27 直连 `tags.update`）在真实生产会报错 → 标签改名功能当前不可用；连带 `tag.updated` 审计触发器（0001 write_audit）因 UPDATE 无法到达而休眠（allowlist 含该值但运行时不可达）。
- **建议**：新建后续 migration 为 `tags` 补 `updated_at timestamptz not null default now()`（与 profiles/assets/images 同型；无数据迁移）；或按 D4 语义删除 `touch_tags_upd`。Phase 7 门禁不因本项阻塞（0006 未触碰 tags，Gate G7 "Assets/Tags 不受影响"=未恶化）。

### DEF-2（cosmetic · 低）
- **文件：行**：`worker/index.ts` L114–116 `authErrBody`（配合 L101–102/authenticate）。
- **现象**：角色/档案查询上游失败（500）时 `auth.code` 未定义 → `authErrBody` 回退 code `'unauthorized'`，响应为 `500 {code:'unauthorized'}`——状态与 code 语义不一致；仅内部日志可见，不泄露细节。
- **建议**：code 回退改为 `'internal'`/`'upstream_error'` 或单独 message；非安全、非阻塞。

---

## 4. Gate G7 就绪度表

| # | Owner 要求证据 | 状态 | 结论依据 |
| --- | --- | --- | --- |
| 1 | 实际 SQL（0006 迁移） | **CONFIRMED** | 隔离库按序 0001→0006 全绿；幂等核对 trigger=1/CHECK=1/index=1/mutation=1/stats=1/is_admin=1 |
| 2 | 权限验证 | **CONFIRMED** | B1–B7 全 PASS + D is_admin 三态 PASS |
| 3 | 并发 last-admin | **CONFIRMED** | A5 双客户端并发交叉互禁恰一成功/败者 FORBIDDEN/活跃≥1；A4/A6/XB/XC 佐证 |
| 4 | disabled Worker 门禁 | **CONFIRMED（静态 + 线上 HTTP）** | E 静态全量覆盖（含 downloads 两端点）；线上 HTTP 冒烟已于任务 #5 部署后执行并通过：**S8 被禁用户带 JWT 调 `/api/admin/users` → `403 {code:'account_disabled'}`**（证据：`docs/phase-7/evidence/online-e2e.md`，13/13 PASS） |
| 5 | RLS 回归 | **CONFIRMED** | A8/A9/B4–B7/C 系列（被禁 admin 全拒、A5 闭包、自禁/自愈拒、published 可见性） |
| 6 | Phase 2–6 回归 | **CONFIRMED** | C1–C6 代表用例 + 0001–0005 对照库基线（各 Phase 至少一条，标注迁移文件） |

**QA 结论**：Phase 7（0006 迁移 + Worker D2 门禁 + 4 admin 端点 + 前端四页）在隔离库与静态层面**未发现阻断性缺陷**；DB 套件 31/31 PASS。Gate G7 六类证据本次可判 **CONFIRMED**（含「disabled Worker 门禁」——线上 HTTP 项由任务 #5 部署后 E2E 闭环，见 `docs/phase-7/evidence/online-e2e.md`）。DEF-1（tags.updated_at，pre-existing）建议排期单独修复，不阻塞本 Gate。
