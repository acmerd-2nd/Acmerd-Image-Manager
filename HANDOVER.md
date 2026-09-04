# 🔄 HANDOVER — ACMERD Image Manager 交接文档

> **最后更新**: 2026-09-04（G9 Closure：第④类响应式运行时证据已补齐，含 DEF-9-1 发现→修复→复验；G9 = PASS）
> **当前状态**: Phase 0-9 ✅ 全 CLOSED（G1–G9 PASS）· **下一步 = Phase 10 Production Release（严格"全量回归+发布"，无新功能）**
> **当前 HEAD**: 见 `git log`（G9 closure commit）；工作树仅故意未入库项（`.workbuddy/` + 两份中文规划文档）
> **线上**: https://image.acmerd.com 运行中（**bundle `index-DosBFCeX.js`**，含 DEF-9-1 修复：AdminLayout `min-w-0`；0001–0008 已上生产，`/api/health` 200）
> **G9 关闭依据**: `docs/phase-9/03-g9-closure-report.md`（三视口 × 全关键页运行时截图 + 客观溢出数值 + Lightbox 交互实测；证据在 `docs/phase-9/evidence/responsive/` 27 张）。执行环境为真实 Chromium（agent-browser），未引入 Playwright、未降低证据标准；期间发现 Admin Users/Audit Logs 在 Tablet/Mobile 的页面级横向溢出（flex 子项缺 `min-w-0`），单类名修复并完成 本地→生产 四步验证链。
> **新 Agent 请先读「第零节 · 接手清单」，再按「第六节 · 当前待办」开工**

---

## 零、新 Agent 接手清单（照此顺序即可无缝接管）

**这是一个"换号/换人"的全新会话，你对此项目零上下文。按下面顺序走：**

1. **读权威文档**（顺序不可跳）：
   - `【总纲】acmerdImage-manager.md`（产品宪章 + Agent 绝对规则）——本地文件，**故意未推送**公开仓库
   - `【分阶段】acmerdImage-manager.md`（Phase 0-10 路线图 + 各 Gate 验收）——同上，本地文件
   - `docs/phase-0/01~12-*.md`（Phase 0 已批准架构基线）
   - `docs/phase-7/01-design-gate.md`（含附录 A1–A6 裁决，是最完整的"裁决落档"范例）
   - `docs/phase-8/02-security-review.md`（**安全基线冻结文件**，G8 后任何改动都要对照它说明是否触碰边界）
   - 本 HANDOVER 全文
2. **确认密钥就位**：项目根 `.env` 必须存在（键名见第二节）。若新机器没有 `.env`，**必须找 Owner 索取原文件**——所有密钥都只在 `.env`，无法从别处重建。`.env` 已被 `.gitignore` 排除，**绝不提交**。
3. **确认工具链**：bash 会话中 `node`/`npm` 可直接用（受管 Node v22）。若 npm 解析失败，回退 `/d/node/npm.cmd`（历史已知可用 Node v24）。`python` 可直接用（受管 3.13）。
4. **验证环境健康**（只读，安全）：
   ```bash
   git log --oneline -3          # 应见 74cae3a 及本交接 commit
   npm run typecheck             # 前后端 TS 0 错误
   curl -s -o /dev/null -w "%{http_code}\n" https://image.acmerd.com/api/health   # 200
   npm run db:migrate            # 全部 skip（幂等）即 DB 状态正确
   ```
5. **确认 DB 状态**：`supabase/migrations/` 有 0001–0007，`schema_migrations` 全记录（本机实测：1 asset / 1 lang / 1 image / 0 tags / 64 audit rows，演示级数据）。**不要在 Supabase Dashboard 手改生产库**——结构变更只许新增 `supabase/migrations/XXXX_*.sql` 后跑 `npm run db:migrate`。
6. **进入 Phase 9**：见「第六节」。**先等 Owner 对 D1–D10 的裁决，严禁未批准先写实现代码。**

**关键红线（违反会被 Owner 打回）**：Service Role Key 只进 Worker Secret / 本地脚本，绝不进前端 bundle / Git / wrangler.toml；权限只靠 UI 隐藏无效，必须 RLS/服务端兜底；改设计先交 Change Proposal；两份中文规划文档 + `.workbuddy/` 不推公开仓库；**未提供证据前不得宣布 Gate PASS**；不扩大 Scope、不重构已完成 Phase。

### 当前状态快照
| 维度 | 值 |
| --- | --- |
| HEAD / 远端 | `74cae3a`（Phase 8）= origin/main，已推送；本交接 commit 紧随其后 |
| 工作树 | 仅未跟踪：`.workbuddy/`[故意]、`docs/phase-9/`[本交接将提交]、两份规划文档[故意] |
| 已应用迁移 | 0001 schema+RLS+storage / 0002 grants / 0003 asset 完整性守卫 / 0004 下载源 URL 守卫 / 0005 search_assets+tag slug+审计 / 0006 Admin 控制台（原子变更 RPC+disabled 门禁+stats+allowlist18）/ 0007 审计收口（asset_languages 五语义+images WHEN 审计+DEF-1 tags.updated_at+allowlist24） |
| Worker 端点 | `/api/health`；`/api/downloads/image/:id`、`/api/downloads/zip`；`/api/admin/storage/delete`；`/api/admin/users`（分页 envelope）、`/api/admin/users/:id/role`、`/api/admin/users/:id/disabled`、`/api/admin/stats`。全部经 `authenticate()`（角色 + `profiles.disabled` 逐请求校验 → 403 `account_disabled`） |
| Worker Secret | `SUPABASE_SERVICE_ROLE_KEY` 已 `wrangler secret put`；本地 `worker/.dev.vars` 同步 |
| 管理员账号 | `1902768564@qq.com`（密码见 `.env` 的 `ADMIN_PASSWORD`），角色 admin |
| 冻结基线 | 双层可见性（Asset+Language published，0007 后语义经 NO-DRIFT 证明未漂移）、多语言模型、三套下载解耦、ZIP ≤30/≤100MB/并发4、public bucket（残余风险已记录，见 D5/5a）、audit allowlist=24、last-admin 原子保护、disabled 门禁对偶（Worker 403 + RLS `is_admin` 含 `disabled=false`） |
| 数据现状 | 生产库极小（1 asset/1 image/0 tags）——**分页/大列表验收必须在隔离库造数**，不许拿生产小数据集充数 |

---

## 一、项目身份

| 项 | 值 |
| --- | --- |
| 项目 | ACMERD Image Manager（品牌：ACMERD · 探知，Research · Discover · Create） |
| 线上地址 | https://image.acmerd.com（已部署，运行正常） |
| GitHub | https://github.com/acmerd-2nd/Acmerd-Image-Manager（公开仓库，默认分支 main） |
| 定位 | 管理员维护图片资产、注册用户浏览+下载的 Digital Asset Library。核心对象是 **Asset**（不是 Image/Folder） |
| 架构 | React SPA + Hono Worker（同一 Worker 托管静态资源与 /api/*）→ Supabase（Auth / PostgreSQL+RLS / Storage） |

> ⚠️ 两份中文规划文档（总纲/分阶段）**故意未推送**到公开 GitHub 仓库，仅存本地。保持现状，勿提交。

---

## 二、密钥与凭据（全部在 `.env`，绝不提交 Git）

`.env`（项目根目录，**本机绝对路径 `E:\【项目】0002.Acmerd-Image-Manager\.env`**）已被 `.gitignore` 排除。换号交接时**原样复制 `.env` 即可**（若新会话在同一台机器上，路径不变、直接可用）。键名一览：

| 变量 | 用途 | 红线 |
| --- | --- | --- |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | 前端+Worker 公开凭据 | 可进前端 bundle，安全靠 RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | 绕过 RLS 的服务端密钥 | **仅** Cloudflare Worker Secret / 本地 scripts；绝不进前端 / Git / wrangler.toml |
| `DATABASE_URL` / `SUPABASE_DB_PASSWORD` | 直连 postgres，跑 migration（`npm run db:migrate`）与脚本 | 绝不进 Git |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | wrangler deploy | 绝不进 Git |
| `GITHUB_TOKEN` | push 代码（PAT，仓库写权限） | 绝不进 Git |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Owner 管理员账号（本地记录用） | 绝不进 Git |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite 构建注入前端 | 公开变量 |

Supabase 项目 ref：`ctddbmadywtdufazhwiq`（Asia-Pacific）。Storage bucket `images`（public=1，唯一桶）已建好，策略齐全。存储对象相对路径格式：`{assetId}/{langCode}/{file}`（DB 的 `images.storage_path` 存的是 `images/{assetId}/{langCode}/{file}`，调 Storage API 时要剥掉首段 `images/`）。

**注意**：本交接文档与一切进入 Git 的文档**故意不写密钥明文**（Phase 8 Secret 扫描基线）。密钥唯一的权威载体就是 `.env`。

---

## 三、本机环境与运维要点（血泪坑合集，跨阶段有效）

1. **bash 中 `node`/`npm` 现可直接用**（Phase 7/8 全程直接用，无需再绕 `D:\node`；历史 HANDOVER 记的"全局 npm 损坏"已过时）。若个别命令解析失败，回退 `/d/node/npm.cmd`。
2. **git push 必须沙箱外执行 + 禁用凭据助手 + HTTP/1.1**（直接 `git push` 会挂在凭据管理器交互等待，曾卡 7 分钟）。可靠模式：
   ```bash
   set -a; . ./.env; set +a
   GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c http.version=HTTP/1.1 \
     -c http.lowSpeedLimit=1 -c http.lowSpeedTime=45 \
     push "https://x-access-token:${GITHUB_TOKEN}@github.com/acmerd-2nd/Acmerd-Image-Manager.git" main
   ```
3. **生产 Postgres 的 postgres 角色非超级用户、只是 `authenticated` 成员** → 模拟 Guest 视角用 `SET ROLE authenticated`（不带 `request.jwt.claim.sub` → `auth.uid()=null`）；**不能 `SET ROLE anon`**（会报非成员）。
4. **node-pg 多语句（simple protocol）返回 `Result[]` 而非单个 Result** → 取行要 `rowsOf` 式助手（取首个有行的 Result）；**参数化查询（`$1`）不能与多语句混用**（extended protocol 禁止）→ 固定字符串直接插值。
5. **事务内语句报错后会话进入 aborted**，后续错误显示为 "current transaction is aborted" 掩盖真凶 → 每条断言用独立 `begin/commit`，catch 里显式 `rollback`。
6. **RLS 对 UPDATE/DELETE 过滤 0 行时返回 204/0 行而不报错**（只有 INSERT `WITH CHECK` 才抛错）→ 验证"写被拒"必须**回读数据确认未变**，不能只看状态码。PostgREST 同理。
7. **Supabase Storage `list` ≠ 权威存在性判断**（返回 basename 非完整路径、有缓存延迟）→ 存在性判定一律用完整相对路径 + 精确 DELETE/HEAD 权威响应。
8. **Supabase `/storage/v1/render/image/public/{obj}?width=&height=&resize=cover` 变换端点实测可用**（200 PNG）→ 缩略图免 Worker 代理（Phase 9 据此选型）。Storage public 对象直出响应 `Cache-Control: no-cache`。
9. **wrangler deploy 结尾 routes 同步步骤会报 `Authentication error [code:10000]`**（token 缺该 zone Workers Routes 读权限）→ **cosmetic，不影响已绑定自定义域**（历史两轮线上 E2E 均证明新版本已生效）。验证是否生效用**判别器**（如新增端点无 token 返回 401 JSON，而非 SPA 200 回落）。若想消除告警需 Owner 在 Cloudflare 补 token 权限（运维项，非 blocker）。
10. **GoTrue 会话撤销**：可用端点只有 `POST /auth/v1/admin/users/{id}/logout`（service role，`/sessions*` 404）。禁用用户先落库后 best-effort 撤会话；**未过期 access token 不会因此失效** → Worker 的 disabled 门禁才是真正的强制点（线上已证：被禁用户带有效 JWT 请求 /api → 403 `account_disabled`）。
11. **隔离库冒烟范式**（`scripts/phase8-isolated-smoke.mjs`）：从 `DATABASE_URL` 拆出主连接建一次性库 → 建桩（storage.buckets/objects、auth.users 触发器桩、`schema_migrations` 表——0002 会对它 REVOKE 所以必须先建、default privileges）→ 0001→000N 全量应用 → 用例 → **finally DROP DATABASE**。生产库/隔离库判定一律靠一次性库名。
12. **生产抽查范式**（`scripts/phase8-prod-spotcheck.mjs`）：只读 sanity 直查；写路径（如审计触发器）用真实 admin 身份 + `BEGIN…ROLLBACK` 包裹，验证后回滚**零残留**。不在生产创建残留用户/不改真实数据。
13. **create function language sql 会校验函数体引用的表** → 函数必须在依赖表之后建；PG 无 docker/psql 本地环境，一切经 node-pg。
14. **审计动作 allowlist**：`audit_logs` 上有 CHECK 约束（当前 24 项，0007 重建）。新增审计动作必须同步扩 allowlist（幂等 DO 块），否则 INSERT 直接报错。

---

## 四、已完成进度明细（Phase 0–8）

### Phase 0 — Architecture Baseline ✅
12 份设计文档在 `docs/phase-0/`，是后续所有阶段的实施依据。

### Phase 1 — Foundation ✅（G1）
React 18 + TS + Vite + Tailwind + shadcn 风格 UI；Hono Worker + `[assets]` SPA 托管；0001 九表 + 27 条 RLS + 审计触发器（`write_audit`）+ `published_assets` 视图 + storage bucket + `assign_first_admin()`；0002 grants（客户端角色对 `user_roles`/`audit_logs` 无写权限）。

### Phase 2 — Authentication ✅（G2）
登录/注册/Profile；`?next=` 白名单（防开放重定向）；密码/语言共享校验器在 `src/lib/validators.ts`；守卫竞态修复（roleLoading 与 setSession 同批）；安全测试 15/15。

### Phase 3 — Asset Core ✅（G3）
0003 asset 完整性守卫（状态化审计 published/unpublished/archived/restored、Cover 同资产守卫、Publish 终守卫）；Worker `POST /api/admin/storage/delete`（精确路径）；Admin 资产列表/新建/编辑三页；用户端 Home/Detail 接真数据；安全测试 25/25。

### Phase 4 — Multi-language ✅（G4）
**零 schema/RLS/Storage/Worker 变更**（纯前端）；语言 Tab 固定序 + `?lang` 校验回退 + replaceState 规范化；双层可见性语义落 UI。

### Phase 5 — Download System ✅（G5）
0004 下载源 URL 守卫触发器（https + 精确 host 白名单）；Worker 单图 302（软门控）+ 流式 ZIP（store 模式、≤30 图/100MB/并发 4、CRC32、无部分成功）；三套下载（单图/ZIP/网盘）彼此解耦、网盘与语言解耦；安全测试 16/16。
**文件名保留结论（重要）**：Supabase public 对象 GET 无 Content-Disposition → 单图原始文件名靠**前端 blob + `a.download=img.filename`** 保住；ZIP 是 Worker 直出 200（非 302），其 `Content-Disposition` 正常生效。

### Phase 6 — Search & Tags ✅（G6）
0005 `search_assets(p_q,p_tags)` SECURITY INVOKER RPC（读 `published_assets`，继承双层可见性；ILIKE 子串 + 多标签 AND + 确定性排序 + 有界校验）；`generate_tag_slug` 触发器；asset_tags 增删审计；Query Layer 分层 `UI → features/search → search_assets() → published_assets → RLS`；`src/features/search/api.ts`、`src/features/tags/api.ts`；Admin Tags 页。
**坑**：视图 tags 是 json、RPC 声明 jsonb → 需 `pa.tags::jsonb` 显式转。

### Phase 7 — Admin Platform Consolidation ✅（G7，commit `d4253ec`）
详见 `docs/phase-7/01-design-gate.md`（附录 A1–A6 = 主理人裁决）+ `02-implementation-report.md` + `evidence/{0006-smoke,worker-endpoints,frontend,qa-report,online-e2e}.md`。要点：
- **0006_admin_console.sql（生产已应用）**：`is_admin()` 收紧为活跃 admin（join profiles + `disabled=false`）；`guard_profile_disabled` 三段式（自禁/自降 forbidden、被禁 admin 不能自愈）；`admin_user_mutation()` 单事务 SECURITY DEFINER RPC（`pg_advisory_xact_lock(hashtext('acmerd_admin_mutation')::bigint)` + 锁内重读 actor/target + **last-admin 普查**——除 target 外仍须 ≥1 活跃 admin，Owner 硬门槛）；`admin_stats()` 7 键原子快照；audit allowlist 18；`(action,created_at desc)` 索引。
- **Worker**：`authenticate()` 逐请求查 `profiles.disabled` → 403 `{code:'account_disabled'}`（D2 门禁，7 个 authed handler 全覆盖）；`authErrBody()` 统一错误体（**code 回退按状态推导**：401→unauthorized / 500→internal，DEF-2 修复）；4 个 admin 端点（users 分页 envelope / role / disabled / stats）；role+disabled 经 service-role 调 `admin_user_mutation`；错误映射 SELF_*/FORBIDDEN→403、LAST_ADMIN→409、TARGET_NOT_FOUND→404；disabled=true 后 best-effort `POST /auth/v1/admin/users/{id}/logout`。
- **前端**：`src/features/admin/api.ts`（AdminApiError + 中文映射）；AuthProvider 并行取 role+disabled，disabled 时折叠为 'user' 并暴露 `isDisabled`；Admin Console 四个真实页（Dashboard/Users/Storage/AuditLogs）替代占位；**移除 Settings 路由/侧栏项**（不扩大 Scope）；Audit 页 = admin JWT 经 RLS 直读（D4，无 Worker 读端点）。
- **并发语义裁决 A1**：并发 last-admin 双 admin 互禁，败者实际为 **FORBIDDEN**（锁内重读更严格）；LAST_ADMIN 可达性由人工负样本证明。
- **QA 31/31 + 线上 E2E 13/13**（含被禁用户带 JWT → 403 `account_disabled` 的 S8 闭环）。
- 复用脚本：`scripts/phase7-online-e2e.mjs`（一次性用户 + finally 清理 + 级联 0 残留）。

### Phase 8 — Security Hardening ✅（G8，commit `74cae3a`）
详见 `docs/phase-8/01-design-gate.md`（重建版 + Owner 裁决）+ `02-security-review.md`（**安全基线冻结**）+ `03-implementation-report.md` + `evidence/{isolated-smoke,secret-scan,production-apply}.md`。要点：
- **0007_audit_hardening.sql（生产已应用）**：
  - **GAP-A** `asset_languages` 五语义审计（created/published/unpublished/updated/deleted 分离留痕——语言 publish 是公开边界第二层开关）；
  - **GAP-B** `images` UPDATE 审计 WHEN 限定业务列（filename/storage_path/mime_type/file_size/width/height/sort_order）——纯 touch/no-op 永不刷屏；
  - **allowlist 18→24**（严格超集，幂等 DO 块）；
  - **DEF-1 pre-existing fix**：`tags` 补 `updated_at`（NOT NULL default now()），恢复 0001 `touch_tags_upd`/`audit_tags_upd` → AdminTagsPage 改名可用。文件头与 Review 显式标记历史缺陷修复。
  - SELECT 面零改动、无 BEFORE 守卫 → published 双门控语义结构性不受影响。
- **Owner 强制的公开集合不漂移回归**：`0001–0006 → 快照 A → 0007 → 快照 B`，Guest 视角（authenticated 无 JWT）**逐字节一致（NO-DRIFT）** + C2b 状态迁移语义正确 —— 证明补审计未改变 published 双门控业务语义。
- **隔离库冒烟 20/20**（`scripts/phase8-isolated-smoke.mjs`，一次性库自动清理）。
- **Secret 扫描 0 命中**（`scripts/security-scan.mjs`，可复跑：git 全历史 237 blobs + dist + 跟踪文件；**阳性对照**证明检出能力：伪造 service_role JWT/DB 密码/私钥 → 命中 → 删分支 → 归零）。
- **生产抽查 14/14**（`scripts/phase8-prod-spotcheck.mjs`：只读 sanity 7/7 + 审计写入链路 ROLLBACK 安全构造 7/7）。
- **Security Review 结论**：五层防线 + Secret + Audit **无阻断性缺陷**。**残余风险已显式记录**：
  - **D5/5a**：public bucket + Worker 软门控为既定模型；"已知 public URL 可 GET"= 产品模型残余风险（Guest 浏览要求图片公开可读），**非阻断**；5b/5c 硬门控/私有化需单独 Change Proposal，不得偷塞进任何 Phase。
  - wrangler routes 列表权限（运维项，cosmetic，非 blocker）。

---

## 五、已完成待办 / 关闭事项
| 事项 | 状态 | 说明 |
| --- | --- | --- |
| DEF-1（tags.updated_at） | ✅ 已随 0007 修复 | Backlog 关闭；改名能力线上验证 |
| Phase 7/8 全部 QA 缺陷 | ✅ 已闭环 | DEF-1 修复 + DEF-2 发布前修复 |
| 邮箱验证开关 | ✅ 关闭 | 注册直返 session；注册页"待验证"分支代码保留兼容 |
| Worker Secret | ✅ 已注入 | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`；`worker/.dev.vars` 同步 |

---

## 六、当前待办：Phase 10 — Production Release（G9 已于 2026-09-04 关闭）

**状态**：Phase 9 全部完成。G9 第④类响应式运行时证据已于 2026-09-04 在真实 Chromium QA 环境补齐，期间发现并修复 DEF-9-1（Admin Users/Audit Logs 在 Tablet/Mobile 页面级横向溢出，根因 `AdminLayout.tsx` flex 子项缺 `min-w-0`；属已批准 D9 范围的精准最小修复）。**G9 = PASS（7/7 CONFIRMED）**，依据 `docs/phase-9/03-g9-closure-report.md`。生产已运行修复版 bundle `index-DosBFCeX.js`。

### Phase 10 进入条件与范围纪律（Owner 明示）
- ~~进入 Phase 10 前须先关闭 G9~~ ✅ G9 已 PASS，条件满足。
- **Phase 10 严格是"全量回归验证 + 发布"，不得塞新功能**（总纲定义：无新功能）。

### Phase 10 回归时复用的不变量（已由隔离库/线上证明）
I1a/I1b `search_assets` 契约零破坏；I2/I2a 分页并集=全量且顺序一致；I3 Guest 集合 NO-DRIFT；I4 RLS/allowlist24/disabled 门禁不漂移。published_assets / is_admin() / RLS / audit / disabled = **冻结基础设施**。

### 补充 QA 环境经验（2026-09-04，供 Phase 10 复用）
- 本会话使用 agent-browser（真实 Chromium）作为 QA 浏览器：`agent-browser set viewport W H` + `open` + `eval` + `screenshot` **必须在同一 Bash 命令链内执行**——守护进程会在调用间随机重置标签页/视口/登录态（曾致 2 张空白截图与登录丢失，识别后已用防御模式规避）。
- Admin 登录态采证：`.env` 的 `ADMIN_EMAIL/ADMIN_PASSWORD` + `input[type=email]/input[type=password]` 选择器登录；Admin 页面**只读查看零变更操作**。
- 溢出判定范式：`document.documentElement.scrollWidth vs clientWidth` + 逐元素 `getBoundingClientRect` 定位溢出源（DEF-9-1 即由此范式定位）。

---

## 七、常用命令（全部在项目根目录）

```bash
npm install                  # 装依赖（bash 中 npm 可直接用；坏了回退 /d/node/npm.cmd）
npm run dev                  # 前端 :5173（/api 代理到 8787）
npm run dev:worker           # Worker 本地 :8787（读 worker/.dev.vars）
npm run typecheck            # 前端 + Worker TS 检查
npm run build                # 构建前端 → dist/
npm run db:migrate           # 应用未执行的 migration（读 .env DATABASE_URL，幂等）
# 部署（先 source .env 导出 CF 凭据）：
set -a; . ./.env; set +a; npm run deploy
# 或直接 wrangler：set -a; . ./.env; set +a; npx wrangler deploy
# 推送（沙箱外，模式见第三节 #2）：
#  ...GIT_TERMINAL_PROMPT=0 git -c credential.helper= ... push https://x-access-token:${GITHUB_TOKEN}@github.com/acmerd-2nd/Acmerd-Image-Manager.git main
```

**数据库铁律**：结构变更只许新增 `supabase/migrations/XXXX_*.sql` 后跑 `db:migrate`，禁止 Dashboard 手改生产库。

---

## 八、固定工作流程（Agent 纪律，摘自总纲，违者 Owner 打回）

1. 每个 Phase 先出 **Design Gate**（Phase/Goal/Scope/Out of Scope/DB/Worker/前端改动面/安全边界/验收），等 Owner 逐项裁决（D1..Dn）并**落档裁决原文**后才实施。
2. 实施顺序与本仓库惯例：DB migration → 隔离库冒烟 → Worker/前端 → QA 独立证据 → 生产 migration（`db:migrate`）→ 线上抽查 → 结束报告（Implemented/Files/Database/Tests/Security/Evidence/Gate Status）→ commit+push → 证据全 CONFIRMED 才宣布 Gate PASS。
3. 不得跳阶段、不得顺手重构别的模块；改设计先交 Change Proposal。
4. 权限只靠 UI 隐藏 = 无效；必须有 RLS/服务端兜底。Admin 重要操作必须落 audit_logs（动作须在 allowlist 内）。
5. V1 禁加：用户上传/编辑、付费、AI Tag、评论点赞、社交、复杂推荐。
6. 产品规则红线：Asset 是核心对象；多语言是 Asset 下的版本；三套下载独立、网盘与语言解耦；Tags 属 Asset；Package Download 0 隐藏/1 直跳/2 选择器；双层可见性是唯一事实来源。
7. **换号衔接纪律**：每阶段结束或换人前，更新本 HANDOVER（含当前 HEAD/状态/下一步/密钥位置/最新坑），并 append 当日 `.workbuddy/memory/YYYY-MM-DD.md`。

---

## 九、代码地图（截至 Phase 8 / Phase 9 前置现状）

```plaintext
supabase/migrations/
├── 0001_initial_schema.sql            # 九表 + RLS + write_audit/touch_updated_at + published_assets 视图 + storage + assign_first_admin
├── 0002_grants.sql                    # anon/authenticated/service_role GRANT；user_roles/audit_logs 客户端无写
├── 0003_asset_integrity.sql           # 状态审计 + Cover/Publish 守卫（guard_asset_publish 等）
├── 0004_download_source_url_guard.sql # download_sources.url https+host 白名单
├── 0005_search_and_tags.sql           # search_assets RPC + generate_tag_slug + audit_asset_tag
├── 0006_admin_console.sql             # is_admin(含 disabled) + guard_profile_disabled 三段式 + admin_user_mutation(advisory lock+last-admin) + admin_stats + allowlist18
└── 0007_audit_hardening.sql           # asset_languages 五语义审计 + images WHEN 审计 + allowlist24 + tags.updated_at(DEF-1)

worker/index.ts                        # Hono：authenticate(JWT+role+profiles.disabled) + authErrBody
                                       # /api/health；/api/downloads/image/:id(302)；/api/downloads/zip(流式)
                                       # /api/admin/storage/delete；/api/admin/users|:id/role|:id/disabled|stats
wrangler.toml                          # 自定义域 image.acmerd.com；[vars] SUPABASE_URL/PUBLISHABLE；SERVICE_ROLE 走 secret
worker/.dev.vars                       # 本地 Worker 变量（含 service key），已 gitignore

src/
├── App.tsx                            # 路由 + guards + ErrorBoundary（Phase 9 将加 React.lazy）
├── features/
│   ├── auth/AuthProvider.tsx          # session+role+disabled（Promise.all，disabled 折叠 'user'，暴露 isDisabled）
│   ├── assets/api.ts · storage.ts · AssetCard.tsx
│   ├── downloads/api.ts · PackageDownloadPanel.tsx   # 三套下载；403 account_disabled 中文文案
│   ├── search/api.ts                  # searchAssets() → rpc('search_assets')（Phase 9 将分页化）
│   ├── tags/api.ts
│   └── admin/api.ts                   # listAdminUsers/changeUserRole/setUserDisabled/getAdminStats + AdminApiError 中文映射
├── components/
│   ├── ui/                            # Button/Card/Input/Badge（自维护 shadcn 风格，零依赖）
│   ├── guards.tsx · ConfirmDialog.tsx
│   └── layout/AppShell.tsx · AdminLayout.tsx   # AdminLayout 侧栏已去 Settings；留移动导航 Phase 9 注释
├── routes/pages/
│   ├── HomePage / SearchPage / AssetDetailPage / ProfilePage / LoginPage / RegisterPage / ErrorPages
│   └── admin/  AdminDashboardPage / AdminUsersPage(数字分页先例) / AdminStoragePage / AdminAuditLogsPage
│               AdminAssetsPage / AssetNewPage / AssetEditorPage / AdminTagsPage
├── lib/supabase/client.ts · validators.ts · utils.ts
└── types/database.ts                  # AssetRow/…/AuditLogRow

scripts/
├── db-apply.mjs                       # migration 执行器（文件名序 + schema_migrations + 幂等）
├── phase7-online-e2e.mjs              # Phase 7 线上 E2E（一次性用户 + 清理）
├── phase8-isolated-smoke.mjs          # Phase 8 隔离库冒烟范式（0001→0007 + NO-DRIFT，一次性库）
├── phase8-prod-spotcheck.mjs          # Phase 8 生产 ROLLBACK 抽查范式
└── security-scan.mjs                  # Secret 扫描（git 全历史 + dist + 跟踪，可复跑 + 阳性对照法）

docs/
├── phase-0/   · phase-7/（gate+impl+evidence，附录 A1–A6）· phase-8/（gate+review+impl+evidence）
└── phase-9/01-design-gate.md          # ⭐ 当前唯一待办（PENDING OWNER REVIEW，§7 裁决块待填）
```

**证据与记忆纪律**：每 Phase 的 evidence 落在 `docs/phase-X/evidence/*.md`；六类证据模板（实际 SQL / 权限验证 / 并发语义 / 门禁线上 / RLS 回归 / 前 Phase 回归）；换人衔接更新本文件 + `.workbuddy/memory/YYYY-MM-DD.md`（append-only，勿删 `.workbuddy/`）。
