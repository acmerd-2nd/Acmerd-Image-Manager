# Phase 8 · Security Review — Security Hardening 收口

> 状态：**PENDING G8**（本 Review 为 G8 唯一硬性验收依据；生产 migration + 线上抽验完成后回填 §9 并宣布）
> 日期：2026-09-03 · 依据：`docs/phase-8/01-design-gate.md`（Owner 裁决版，D1–D6 APPROVED）
> 本报告结构对齐门禁 §9：五层防线（M1–M5）→ Secret（M6）→ Audit（M7）→ 残余风险 → DEF-1 修复记录 → 证据链与结论。

---

## 0. 结论速览

| 层 / 项 | 结论 | 关键证据 |
| -- | ---- | ---- |
| L1 Frontend Guard | PASS（复验） | Phase 7 前端 + 本 Phase 无前端改动面 |
| L2 Route Guard | PASS（复验） | 同上 |
| L3 API Authorization（Worker） | PASS（复验） | Phase 7 QA E 静态 + 线上 E2E 13/13（S8 403） |
| L4 Supabase RLS | PASS（复验 + 本 Phase 隔离库新增负样本） | 隔离库 C10a/b/c + Phase 7 QA |
| L5 Storage Policy | **残余风险声明**（D5/5a，非阻断） | 见 §5 |
| M6 Secret | PASS（脚本化零命中 + 阳性对照） | `evidence/secret-scan.md` |
| M7 Audit 完整性 | PASS（GAP-A/B 已收口） | `0007` + 隔离库 20/20（含 NO-DRIFT） |
| DEF-1（pre-existing） | 已修复（恢复既有功能，非新增） | 隔离库 DEF-1 pre/post + C8 |

---

## 1. L1 Frontend Guard / L2 Route Guard — PASS（复验）

- 现状：React 前端 `RequireAuth/RequireAdmin/RequireActive` 守卫（src/components/guards.tsx）+ 路由层按角色折叠（Phase 7 后移除 Settings，四页 Admin Console）。AuthProvider 并行读取 `role + disabled`，disabled 时折叠有效角色为 `user` 并按安全方向兜底。
- Phase 8 未改动任何前端代码（Scope 仅 DB 0007 + 脚本 + 文档）。
- 结论：**UI 绕过面**在 Phase 7 已覆盖（A5 裁决：disabled 折叠、guards 语义），本 Phase 无新增攻击面，维持 PASS。
- 证据引用：Phase 7 QA 前端 F 项 PASS、`docs/phase-7/evidence/frontend.md`。

## 2. L3 API Authorization（Worker）— PASS（复验）

- 现状：`worker/index.ts` 对每个 `/api` 请求经 `authenticate()` 并行校验 JWT + `profiles.disabled`（D2 硬门禁 → `403 {code:'account_disabled'}`，7 个 authed handler 全覆盖含 downloads image/zip）；`requireAdmin` 服务端二次判定 admin 端点；4 个 admin 端点经 service-role 调 `admin_user_mutation()`（advisory lock + last-admin 原子保护）。
- 线上证据（Phase 7，G7 已判）：真实 admin 走 Worker 端点禁用临时用户 → 200 全链（worker→RPC→审计→best-effort 撤会话）；**被禁用户携带有效 JWT 调 `/api/admin/users` → 403 account_disabled**（online E2E S8）。
- 结论：**Worker/API 直接调用面**越权与禁用拦截已闭环，维持 PASS。
- 证据引用：`docs/phase-7/evidence/online-e2e.md`（13/13）、`qa-report.md`（E 静态全量）。

## 3. L4 Supabase RLS — PASS（复验 + 新增负样本）

- 现状：assets/images/tags/asset_tags/asset_languages/download_sources 写策略全部 `using(is_admin())`（0006 收紧版 = 活跃 admin：role='admin' AND disabled=false）；`profiles` UPDATE 仅本人行（0001）；`audit_logs` 仅 admin SELECT（0006）；0006 RPC `admin_user_mutation` 原子化 last-admin 保护。
- 本 Phase 隔离库新增直接攻击负样本（user1 身份、RLS 真实生效）：

| # | 场景 | 结果 |
| -- | ---- | ---- |
| C10a | user1 `UPDATE asset_languages SET status='published'` | RLS `using(is_admin())` 过滤 → 0 行（无旁路） |
| C10b | user1 尝试后无审计行产生 | before=1 after=1 |
| C10c | user1 `INSERT asset_languages` | `new row violates row-level security policy` |

- 结论：**Supabase 直连面**对普通 USER 的越权写（M1/M2/M3 的 DB 层）在 RLS 语义与动态用例双重复证下不可达；disabled 门禁对偶（is_admin 含 disabled=false + Worker 403）使 M4 直连/API 双面闭合。维持 PASS。

## 4. L5 Storage Policy — 残余风险声明（D5/5a，非阻断）

> **Security Review 明确记录（Owner D5 要求原文语义）**：
> "Guest 正常浏览要求图片对象公开可读，因此'已知公开 URL 可 GET'属于当前产品模型下的残余风险，而非 Phase 8 阻断缺陷。当前 bucket 为 public，`GET {公开URL}` 不需要任何鉴权；普通 API 鉴权无法消除该面（Guest 浏览本身要求可读）。Phase 8 将本约束明确识别并记录；5b（private bucket + 签名 URL）/ 5c（防盗链）作为后续独立提案，不进入本 Phase。"

- 现状核对：上传对象存 `public` bucket，路径含随机化组件（storage.ts 生成，非用户可控原文件名直存）；对象公开可读是 Guest 浏览的产品前提。
- M5 不适用三层攻击面模型（非访问控制可消除项），采用"行为快照 + 声明"方式（Gate §4）。已记录的公开数据集合行为快照：隔离库 NO-DRIFT（published_assets 双层可见性，Guest 视角）。
- 其他非阻断项（记录不扩大 Scope）：① wrangler routes 列表步骤缺 zone Workers Routes 权限（Phase 7，不影响已绑定自定义域服务）；② GoTrue 会话撤销为 best-effort（disabled 端点先落库后撤销，失败仅日志；配合 Worker 403 门禁与 RLS 对偶，access token 即使未失效也无法使用管理/受保护面）。

## 5. M6 Secret 泄漏 — PASS（脚本化零命中 + 阳性对照）

- 工具：`scripts/security-scan.mjs`（可复跑）。扫描面：git 全历史（237 个文本 blob）、dist 产物、`.env*` 跟踪/忽略状态、全部跟踪文件敏感赋值。
- 结果：**SECRETS=0 / SAMPLES=0 / EXIT=0**。`.env` 存在但 gitignored；`.env.example` 为占位模板（豁免）。
- **阳性对照**（证明检出能力非空转）：临时分支提交含伪造 service_role JWT / DB 连接串含密码 / 私钥块的文件 → 扫描命中 4 类 7 条（git-history + tracked 双通道）；删除分支后复扫归零。
- 证据：`docs/phase-8/evidence/secret-scan.md`。

## 6. M7 Audit 完整性 — PASS（GAP-A/B 收口）

### 6.1 修复前盲区（调研实证）

- GAP-A：`asset_languages` 增删改零审计（0001 仅 touch 触发器；0003/0005/0006 均未补）——语言的 draft↔published 是 published_assets **第二层可见性开关**，此前无留痕。
- GAP-B：`images` UPDATE 无审计（0001 仅 uploaded/deleted）——Admin 重排 sort_order / 文件名变更无留痕。

### 6.2 修复后 audit action 全量清单（24 项，0006 18 项 → 0007 24 项）

`asset.*`（7）+ `image.uploaded/deleted/updated`（3）+ `tag.*`（3）+ `asset.tag_added/removed`（2）+ **`asset_language.created/published/unpublished/updated/deleted`（5）** + `download_source.updated`（1） + `user.*`（3） = **24** ✓（隔离库 C12 count=24）

### 6.3 语义与防刷屏验证（隔离库 20/20，关键项）

| 场景 | 结果 |
| ---- | ---- |
| INSERT/DELETE 语言 → created/deleted 各 1 行，语义独立 | PASS |
| draft→published → `asset_language.published`（metadata from→to），不被 updated 淹没 | PASS |
| published→draft → `asset_language.unpublished` | PASS |
| 业务列变化（language_code 改）→ `asset_language.updated` | PASS |
| 纯 touch / no-op UPDATE → 不新增 updated（防刷屏） | PASS（C4b） |
| images `sort_order` 1→9 → `image.updated` 1 行（WHEN 命中） | PASS（C6） |
| images no-op（`sort_order=sort_order`）→ 不触发（WHEN 排除纯 touch） | PASS（C7） |
| 越界 action（`hacker.pwned`）→ CHECK 拒绝 | PASS（C9b） |

### 6.4 Owner 强制项：公开数据集合不漂移（§6.4 / §10#3）

- **静态保证**：0007 仅追加 AFTER 审计触发器（写 audit_logs）+ tags 补列 + 换 allowlist CHECK；SELECT 面（published_assets / search_assets）零改动；无 BEFORE 数据守卫、无 NEW/OLD 篡改。
- **动态证明**：Guest 视角（authenticated 无 JWT）同一组查询在 0007 前后快照**逐字节一致（NO-DRIFT PASS）**；状态迁移语义正确（语言 publish 后 language_count 2→增 1，Guest 可见集合随状态增减）且对应审计行语义分离。
- **结论：补审计未改变原有 published 双门控语义。** 证据：`evidence/isolated-smoke.md`。

## 7. DEF-1 修复记录（pre-existing defect fix，D4 要求标记）

- **性质**：0001 引入的历史缺陷——`tags` 表无 `updated_at` 列（0001 L123-129）却存在引用它的 `touch_tags_upd`（BEFORE UPDATE，L165），任何 tags UPDATE 报 `record "new" has no field "updated_at"`，**AdminTagsPage 改名实际不可用**（Phase 7 QA DEF-1 实证 + 隔离库 DEF-1 pre 复现）。
- **修复**：0007 为 `tags` 补 `updated_at` 列（回填 created_at → not null → default now()），恢复 0001 既有两触发器（touch_tags_upd / audit_tags_upd）可用性。
- **定性**：恢复既有功能，**非 Phase 8 新增能力**（migration 文件头与本报告均显式标记）。
- **验证**：0007 前改名被阻断（PASS 复现）→ 0007 后改名成功 + updated_at 落值 + `tag.updated` 审计行恢复（C8/C8b）。

## 8. 证据链与 G8 结论

| # | 证据 | 状态 |
| -- | ---- | ---- |
| 1 | 实际 SQL（0007，含 pre-existing fix 标记） | **CONFIRMED**（生产已应用，schema_migrations 记录，evidence/production-apply.md S1） |
| 2 | 隔离库验证 0001→0007 | CONFIRMED（20/20，evidence/isolated-smoke.md） |
| 3 | 公开集合不漂移回归 | CONFIRMED（NO-DRIFT 逐字节 + C2b 状态语义） |
| 4 | Secret 扫描 | CONFIRMED（0 命中 + 阳性对照，evidence/secret-scan.md） |
| 5 | 权限/越权回归（M1–M5） | CONFIRMED（隔离库 C10 + Phase 7 QA/线上证据链） |
| 6 | 生产应用 + 线上抽验 | **CONFIRMED**（迁移应用 + 只读 sanity 7/7 + 审计写入链路安全构造 7/7，evidence/production-apply.md） |

**Security Review 主体结论**：五层防线 + Secret + Audit 在六类证据下**未发现阻断性安全缺陷**；残余风险（public bucket 已知 URL 可读）已按 D5/5a 识别记录，非阻断。
**G8 = Security Review Passed — 六类证据全部 CONFIRMED，G8 可宣布**（正式宣布见 `03-implementation-report.md`）。
