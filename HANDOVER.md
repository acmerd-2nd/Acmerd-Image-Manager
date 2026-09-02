# 🔄 HANDOVER — ACMERD Image Manager 交接文档

> **最后更新**: 2026-09-02
> **当前状态**: Phase 0 ✅ · Phase 1 ✅（已上线）· **Phase 2 待开始**
> **新 Agent 从「第六节 · 下一步任务」直接接手即可**

---

## 一、项目身份

| 项 | 值 |
| --- | --- |
| 项目 | ACMERD Image Manager（品牌：ACMERD · 探知，Research · Discover · Create） |
| 线上地址 | https://image.acmerd.com （已部署，运行正常） |
| GitHub | https://github.com/acmerd-2nd/Acmerd-Image-Manager （公开仓库，默认分支 main） |
| 定位 | 管理员维护图片资产、注册用户浏览+下载的 Digital Asset Library。核心对象是 **Asset**（不是 Image/Folder） |
| 架构 | React SPA + Hono Worker（同一 Worker 托管静态资源与 /api/*）→ Supabase（Auth / PostgreSQL+RLS / Storage） |

**必读文档（按顺序）**：

1. `【总纲】acmerdImage-manager.md`（项目根目录，产品/架构总宪章，含 Agent 18 条绝对规则）
2. `【分阶段】acmerdImage-manager.md`（Phase 0-10 施工路线图 + Gate 验收标准）
3. `docs/phase-0/01~12-*.md`（已获 Owner 批准的架构基线：ERD / Schema / RLS / Storage / Route / API / 下载流 / 多语言流 / Admin 工作流 / 密钥计划）
4. `README.md`

> ⚠️ 两份中文规划文档（总纲/分阶段）**故意未推送**到公开 GitHub 仓库，仅存本地。保持现状，勿提交。

---

## 二、密钥与凭据（全部在 `.env`，绝不提交 Git）

`.env`（项目根目录）已被 `.gitignore` 排除，内容一览：

| 变量 | 用途 | 红线 |
| --- | --- | --- |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | 前端+Worker 公开凭据 | 可进前端 bundle，安全靠 RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | 绕过 RLS 的服务端密钥 | **仅** Cloudflare Worker Secret / 本地 scripts；绝不进前端/ Git / wrangler.toml |
| `DATABASE_URL` / `SUPABASE_DB_PASSWORD` | 直连 postgres，跑 migration（scripts/db-apply.mjs） | 绝不进 Git |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | wrangler deploy | 绝不进 Git |
| `GITHUB_TOKEN` | push 代码（PAT，对仓库有写权限） | 绝不进 Git |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Owner 的管理员账号（已创建+提权） | 本地记录用，绝不进 Git |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite 构建注入前端 | 公开变量 |

Supabase 项目：`ctddbmadywtdufazhwiq`（Asia-Pacific）。Storage bucket `images`（public）已建好，策略齐全。

---

## 三、本机环境须知（Windows 专属坑）

1. **全局 npm 已损坏**（`C:\Users\Admin\AppData\Roaming\npm` 缺 npm-cli.js）。一律使用 `D:\node\npm.cmd` 和 `D:\node\npx.cmd`。Node v24.16.0。
2. Shell 是 Git Bash。**临时文件路径在 bash 与 node 之间不一致**（bash 的 `/tmp` ≠ node 的 `/tmp`）→ 用项目内相对路径（如 `.tmp_xxx`），用完删除。
3. `wrangler deploy` 前必须先 `set -a; source .env; set +a` 导出 CF 凭据（或用 `npm run deploy`）。
4. pg 多语句查询是**隐式事务**：一个 migration 文件失败会整体回滚，不留半成品。
5. PostgreSQL 14+ 创建 `language sql` 函数时会**校验函数体引用的表**——函数必须在依赖的表之后创建（0001 里 `is_admin()` 放在建表后的原因）。
6. `wrangler.toml` 中 `routes` 等顶层键必须放在任何 `[section]` **之前**，否则会被解析进错误的段（踩过：routes 进了 [vars]）。

---

## 四、已完成进度明细

### Phase 0 — Architecture Baseline ✅（Owner 已批准）
- 12 份设计文档在 `docs/phase-0/`，是后续所有阶段的实施依据。

### Phase 1 — Foundation ✅（Gate G1 PASS）
- **前端**：React 18 + TS + Vite + Tailwind + shadcn 风格组件（`src/components/ui/`）；AppShell（顶部导航，Admin 链接仅 admin 可见）；AdminLayout（侧边栏 + 7 个占位页）；路由全套（`/` `/search` `/asset/:slug` `/login` `/register` `/profile` `/403` `/404` `/admin/*`）；`RequireAuth`/`RequireRole` 路由守卫；`AuthProvider`（session + role，role 来自 `user_roles` 表自身行）；ErrorBoundary。
- **Worker**：`worker/index.ts`（Hono），`/api/health` 已通；SPA 静态资源由 `[assets]` 绑定托管（深链回退 single-page-application）。
- **数据库**（已应用 migration）：
  - `0001_initial_schema.sql`：9 张表（profiles/user_roles/assets/asset_languages/images/tags/asset_tags/download_sources/audit_logs）、27 条 RLS 策略、审计触发器（write_audit）、published_assets 视图、storage bucket + 4 条 Storage Policy、`assign_first_admin()` 提权函数。
  - `0002_grants.sql`：anon/authenticated/service_role 的表级 GRANT（**2026-09-02 刚应用**）。安全设计：`user_roles`/`audit_logs` 客户端角色**无写权限**（改角色只能走 Worker service role，强制留审计）；`schema_migrations` 对客户端关闭。
- **部署**：`https://image.acmerd.com` 运行中（自定义域绑定 Worker）；`/api/health` 200；深链 200。
- **Git**：已推送 main（commit `560cf2f` + 之前 `c8f1bd5` 是 Owner 手传的旧占位 Worker）。

### 管理员账号 ✅（已就绪）
- `1902768564@qq.com` / 密码见 `.env` 的 `ADMIN_PASSWORD`
- 已通过服务端 Admin API 创建（email_confirm=true，绕过邮箱验证），已用 `assign_first_admin()` 提权为 `admin`
- 已验证：密码登录 200；JWT 查 user_roles 返回 admin；INSERT assets 成功（RLS+GRANT 双通过）

### RLS 冒烟测试 ✅（2026-09-02 全部通过）
```
admin INSERT assets        → 成功（已清理测试数据）
anon  SELECT assets        → [] （RLS 过滤，非报错）
anon  SELECT schema_migrations → permission denied ✓
```

---

## 五、待 Owner 配合 / 当前挂起事项

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| **邮箱验证开关** | ⚠️ 当前为**开启**（`mailer_autoconfirm: false`） | Owner 要求"上线再开"→ 现在应关闭。需要 Owner 在 Supabase Dashboard → Authentication → Sign In / Up → Email → 关闭 "Confirm email"（Service Role Key 无法改这个配置，Agent 改不了）。**在关闭之前，Phase 2 注册页必须兼容"待验证"状态**（注册后提示查收邮件，见第六节） |
| Worker Secret 注入 | ⏳ 未做 | Phase 2 需要：`set -a; source .env; set +a; npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`（粘贴 .env 里的值） |

---

## 六、下一步任务：Phase 2 — Authentication（未开始）

按 `【分阶段】` 文档执行。**开工前先输出 Phase 开始报告**（模板见第八节），完成后对照 Gate G2 验收。

### 任务清单
1. **登录页** `/login`：邮箱+密码表单 → `supabase.auth.signInWithPassword`；错误分桶提示（凭据错误 / 未验证 / 网络）；已登录访问则跳 `/`；支持 `?next=` 回跳。
2. **注册页** `/register`：
   - 密码规则（Owner 要求）：**至少 8 位，且包含数字、大写、小写中的至少两类**（例：`20011228fqh` 合法）。前后端各校验一次。
   - 注册后行为分支：若邮箱验证仍开着 → 显示"请查收邮件"页（检查返回的 `user.email_confirmed_at` 或 session 是否为空）；若已关 → 直接登录进站。
   - 触发器会自动建 profiles + user_roles('user')，无需前端额外写。
3. **Profile 页** `/profile` 升级：显示邮箱/角色；可编辑 `display_name`（RLS 限本人行）。
4. **Auth 集成检查**：AuthProvider 已就绪（`src/features/auth/AuthProvider.tsx`），导航栏登录态切换已实现；补 Logout 后清缓存。
5. **安全测试（必须执行并写入收工报告）**：
   - 未登录访问 `/admin` → 跳登录；USER 访问 `/admin` → 403
   - 创建临时测试用户（Admin API `POST /auth/v1/admin/users`）→ 用其 JWT 尝试：INSERT/UPDATE/DELETE assets（应 42501 拒绝）、UPDATE user_roles（应拒绝）、SELECT assets（只见 published）→ 测完 `DELETE /auth/v1/admin/users/:id` 删除
6. 构建 + 部署 + 线上验证 + 提交推送。

### Gate G2 验收标准（来自分阶段文档）
```
注册正常 / 登录正常 / Session 正常 / Role 正常 / Admin Guard 正常
```

### Phase 3-10 概要（详见分阶段文档，勿跳级）
Phase 3 Asset Core（Admin 建 Asset/上传/排序/Cover/Publish，用户浏览）→ 4 多语言 → 5 下载三件套 → 6 搜索+Tag → 7 Admin 控制台 → 8 安全加固 → 9 UX/性能 → 10 发布。

---

## 七、常用命令（全部在项目根目录）

```bash
"/d/node/npm.cmd" install        # 安装依赖（全局 npm 是坏的，必须用 D:\node）
"/d/node/npm.cmd" run dev        # 前端开发 :5173（/api 代理到 8787）
"/d/node/npm.cmd" run dev:worker # Worker 本地 :8787（读 worker/.dev.vars）
"/d/node/npm.cmd" run typecheck  # 前端 + Worker TS 检查
"/d/node/npm.cmd" run build      # 构建前端 → dist/
"/d/node/npm.cmd" run db:migrate # 应用未执行的 migration（读 .env 的 DATABASE_URL，幂等）
# 部署（先导出 CF 凭据）：
set -a; source .env; set +a; "/d/node/npx.cmd" wrangler deploy
# 推送（用 token，origin 已配置）：
git push https://x-access-token:${GITHUB_TOKEN}@github.com/acmerd-2nd/Acmerd-Image-Manager.git main:main
```

**数据库铁律**：结构变更只许新增 `supabase/migrations/XXXX_*.sql` 后跑 `db:migrate`，禁止 Dashboard 手改生产库。

---

## 八、固定工作流程（Agent 纪律，摘自总纲，违者 Owner 会打回）

1. **每个 Phase 开工前**输出开始报告：Phase / Goal / Scope / Out of Scope / Files / Database Impact / Security Impact / Acceptance Criteria。
2. **完成后**输出结束报告：Implemented / Files Changed / Database Changes / Tests / Security Tests / Known Issues / Gate Status。
3. 不得跳阶段、不得顺手重构别的模块；需要改设计先交 Change Proposal 等 Owner 批准。
4. 权限只靠 UI 隐藏 = 无效；必须有 RLS/服务端兜底。
5. Admin 重要操作必须落 audit_logs；Service Role Key 只进 Worker Secret。
6. V1 禁加：用户上传/编辑、付费、AI Tag、评论点赞、社交、复杂推荐（总纲 54 条）。
7. 关键产品规则：Asset 是核心对象；多语言是 Asset 下的版本（不拆 Asset）；三种下载（单图/多选 ZIP/网盘）是独立机制；**网盘下载与语言完全解耦**；Tags 属于 Asset；Package Download 按链接数量：0 隐藏 / 1 直跳 / 2 选择器。

---

## 九、快速上下文索引（代码地图）

```plaintext
src/
├── App.tsx                     # 全部路由 + 守卫挂载
├── features/auth/AuthProvider  # session/role 上下文（role 查 user_roles 自身行）
├── features/assets/AssetCard   # 资产卡片（cover 占位，Phase 3 接真图）
├── components/ui/              # Button/Card/Input/Badge（shadcn 风格，自维护）
├── components/guards.tsx       # RequireAuth / RequireRole
├── components/layout/          # AppShell（用户端导航）/ AdminLayout（后台侧边栏）
├── routes/pages/               # 各页面（AuthPlaceholderPage 是 Phase 2 要替换的占位）
└── lib/supabase/client.ts      # 前端 Supabase Client（仅 Publishable Key）

worker/index.ts                 # Hono：/api/health + 静态资源转发
wrangler.toml                   # routes 必须在 [section] 前！（见第三节坑 6）
supabase/migrations/            # 0001 schema+RLS+storage / 0002 grants（均已应用）
scripts/db-apply.mjs            # migration 执行器（幂等）
```
