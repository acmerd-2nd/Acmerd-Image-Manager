# 🔄 HANDOVER — ACMERD Image Manager 交接文档

> **最后更新**: 2026-09-03（Phase 5 收工）
> **当前状态**: Phase 0-4 ✅ · **Phase 5 ✅（Gate G5 PASS）** · Phase 6 待开始
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

## 三·五、平台工程铁律（跨阶段长期有效，所有 Agent 必须遵守）

1. **Supabase Storage `list` ≠ 权威存在性判断。** `object/list` 返回的 `name` 是 **basename 而非完整相对路径**，且有**缓存延迟**（刚上传/刚删除的对象短时间内可能查不到或仍显示）。任何"对象是否存在 / 是否已删除"的判定，一律用**完整相对路径 `{asset}/{lang}/{file}` + 权威响应**（精确 DELETE 返回 200=之前存在、400 NoSuchKey=不存在；或 HEAD public URL 但注意 CDN 缓存）。清理/校验脚本必须遵循此律（Phase 3/4 均因违反踩过坑）。
2. **PostgREST 对 RLS 过滤后 0 行命中的 UPDATE/DELETE 返回 204/200，不代表放行。** 验证"写被拒"必须**回读数据确认未变**，不能只看状态码。
3. **Supabase Storage 把 RLS 拒绝包装成 HTTP 400 + body `{statusCode:403, code:'AccessDenied'/'new row violates row-level security'}`**，不是直接 403。安全测试断言要按 body 判定。
4. **可见性规则是单一事实来源，禁止在各阶段重新发明。** 前台可见 = `Asset.status='published' AND Language.status='published'`（图片再叠加其语言可见）。Phase 5 下载、Phase 6 搜索**必须直接继承**这套双层门控（RLS 已在 0001 落地），UI 层不得作为唯一屏障。
5. **多语言模型已冻结为长期基线**：`Asset → asset_languages(EN/DE/IT/FR/ES) → images`，语言是 Asset 下的版本，**绝不拆成 Asset-EN/Asset-DE**。`?lang` 只是前端状态同步，不是权限入口。

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

### Phase 2 — Authentication ✅（Gate G2 PASS，2026-09-02）
- **登录页** `/login`：`signInWithPassword`；错误分桶（凭据错误/未验证+重发按钮/限速/其他）；`?next=` 白名单（反复解码后在最终形态校验，拒绝 `//`、`\`、`:`、控制字符及双重编码绕过）；已登录访问回跳。
- **注册页** `/register`：共享校验器 `src/lib/validators.ts`（≥8 位且数字/大写/小写至少两类，唯一实现）；注册分支按 Supabase 返回值判定（有 session 直接进站 / 无 session 显示查收邮件）；**无前端兜底写入**，profiles/user_roles 全靠触发器。
- **Profile 页**：display_name 编辑（RLS 限本人行），实测保存+刷新持久化。
- **守卫竞态修复**：`roleLoading` 与 setSession 同批同步更新（否则登录后瞬间误判 403）；role 查询失败按安全方向兜底为 'user'。
- **安全测试 15/15 通过**（PostgREST + 临时 USER JWT）：INSERT assets 403；UPDATE/DELETE published 资产数据未被改动（注意：PostgREST 对 RLS USING 过滤后 0 行命中返回 204，必须回读验证数据不变）；user_roles 自我提权/新增行 403（permission denied）；SELECT 仅见 published；user_roles 仅见本人行。触发器三表联动验证通过。临时用户与测试数据全部清理。
- **线上实测**：未登录 /admin → /login；USER /admin → /403；admin `?next=%2Fadmin` 登录直达后台；`?next=//evil.com` 被拒；错误密码提示正确；弱密码注册被拦截。
- **Git**：commit `3e6ac7e` 已推 main。

### Phase 3 — Asset Core ✅（Gate G3 PASS，2026-09-02，Owner 过 Design Gate 后实施）
- **DB**：`0003_asset_integrity.sql`（无表结构变更）：① 状态化审计（asset.published/unpublished/archived/restored，Owner 批准 unpublished + archived 可恢复）；② Cover 同资产守卫（COVER_MISMATCH）；③ **Publish 服务端终守卫**（PUBLISH_BLOCKED：INSERT 直接 published 也拦）。三守卫冒烟+负样本全过。
- **Worker**：`POST /api/admin/storage/delete`（Owner 裁决通道）：验证调用者 JWT 为 admin（/auth/v1/user + service role 查 user_roles）→ Service Role 按**精确对象路径**删。**坑**：Storage 的 `{prefixes}` 目录删除不递归子文件夹、list 有延迟缓存 —— 唯一可靠方式是前端从 images 表收集 `storage_path` 传精确路径；prefixes 须为 bucket 内相对路径（剥掉首段 `images/`）。
- **前端**：Admin 资产列表/新建/编辑三页（上传直传 admin JWT；排序 V1 用上移/下移，拖拽留 Phase 9；语言删除仅限 0 图；Publish 前客户端预检+服务端终审）；用户端 HomePage/AssetDetailPage 接真数据（published_assets 视图 + published 链查询）；AssetCard 真封面。
- **安全测试 25/25**：USER 对 assets/asset_languages/images 全只读（UPDATE/DELETE 用回读验证，非状态码）；Storage USER 上传/删除拒绝（RLS 拒绝被 Storage 包成 HTTP 400 + body statusCode 403）；Worker 端点 无凭据401/伪造JWT401/USER 403/恶意路径400/ADMIN 删除真删（权威复查）；Phase 2 不变量回归（自我提权 403 等）。
- **线上 UI 实测**：新建→上传→Set Cover→Publish→游客浏览卡片+详情→Archive→游客不可见→Restore→Delete，审计链完整（created→uploaded→updated→published→archived→restored→deleted）。
- **已知小坑**：① Supabase Storage list 有缓存延迟，删除验证必须用"精确 DELETE → 看 NoSuchKey(400)"；② supabase 的 PostgrestError 不是 Error 实例，throw 时要 `new Error(error.message)`，否则 UI 显示 [object Object]（已修）；③ CF wrangler deploy 的 routes 步偶发 10000 认证错误，重试即可，版本实际已生效。

### Phase 4 — Multi-language ✅（Gate G4 PASS，2026-09-03，Owner 过 Design Gate 后实施）
- **零 schema/RLS/Storage/Worker 变更**（按 Owner 约束）：语言状态模型、双层可见性、路径约定全部沿用 0001/0003 基线。纯前端阶段。
- **数据层**：`api.ts` 新增 `listPublishedLanguages`（显式 `.eq('status','published')`，draft 语言对任何角色都不出现在 public 页）、`listImagesByLanguage`；移除死代码 `listPublishedImages`。
- **校验**：`validators.ts` 新增 `parseLanguageCode`（?lang 唯一实现，**仅小写** en/de/it/fr/es；大写/非法一律 null → 调用方静默回退）。
- **用户端 `/asset/:slug`**：语言 Tab（固定顺序 EN→DE→IT→FR→ES，只列 published）；默认 en 否则首个 published；`?lang` 命中 published 才用，否则回退；**replaceState 规范化 URL**（无效/draft/大写都改写为有效语言）；切换只换 Image Grid，不重载 Asset。
- **Admin 编辑器**：新增语言状态总览条（每语言 图数·status·用户可见✓，固定顺序）。
- **线上实测全过**：EN/DE/IT/ES published + FR draft 场景 → public 只 4 Tab（无 FR）；点 Deutsch 网格切蓝图 + URL ?lang=de；?lang=fr→静默回退 en；?lang=ES(大写)→判无效回退 en；?lang=es→持久选中西班牙语；刷新保持。
- **安全回归**：游客 API 只见 4 published 语言 + 8 图，FR 语言行与图片均不可见（双层 RLS 铁证）；Phase 2/3 不变量未触碰（无 RLS/Worker/schema 改动）。
- **坑复现**：Storage list 返回的 `name` 是 basename 非全路径 → 清理孤儿对象必须用完整相对路径 `{asset}/{lang}/{file}` 精确删（已踩并修正清理脚本）。
- **Git**：Phase 4 commit 已推 main。

### Phase 5 — Download System ✅（Gate G5 PASS，2026-09-03，Owner 过 Design Gate + 4 决策后实施）
- **Owner 决策**：A=维持 public bucket（单图为软门控，硬门控留 Phase 8）；B=ZIP 中任一 file_size 为 null → 拒绝（绝不当 0）；C=加 0004 URL 校验触发器（https + 精确 host 白名单，禁子串）；D=ZIP 上限 30 图 / 100MB / 并发 4。**无部分成功**：流式中途读失败即中断流（无效 zip），不返回"跳过文件的假成功"。
- **DB**：`0004_download_source_url_guard.sql`——`download_sources.url` BEFORE 触发器，仅 https、host 精确等于 `pan.quark.cn/pan.baidu.com/yun.baidu.com`、拒 userinfo/端口/控制字符。正/负样本全过（子串伪装域 `pan.quark.cn.evil.com` 被拒）。
- **Worker**（复用已注入的 Service Role Secret）：
  - `requireUser`（JWT→/auth/v1/user→查 user_roles，user 或 admin）+ CORS（仅 image.acmerd.com + localhost）
  - `GET /api/downloads/image/:id`：软门控 + 双层发布校验（**注意 image→language→asset 是多对一，PostgREST embed 返回对象非数组**，踩坑修正）→ 302 public URL
  - `POST /api/downloads/zip`：service role 校验语言/资产 published + imageIds 全属该语言（跨语言 400）→ 限额（>30 400、null file_size 413、>100MB 413）→ 预检 HEAD（有界并发 4，缺失则流前 502）→ **流式 store 模式 ZIP**：有界预取按 sort_order 写出，每文件缓冲≤15MB 算 CRC32，内存只留中央目录；Content-Disposition `{slug}-{lang}.zip`（消毒）
- **前端**：`features/downloads/`（api + PackageDownloadPanel）+ `validators.isSafePackageUrl`（与 DB 同规则二次防御）。详情页：单图下载按钮（登录门控）、ZIP 选择模式（≤30、切语言清空、底部浮条）、Package 面板（0 隐藏/1 直跳/2 选择器，**与语言完全解耦**，仅 `window.open` 安全 URL）。
- **安全测试 16/16**：guest 401；USER 下载 published 单图/ZIP 200；draft 语言/资产图 404；ZIP 跨语言 400 / >30 400 / null file_size 413；ZIP 结构合法（PK 头 + EOCD + 条目数）；Package guest RLS 0 行 / user 2 行；恶意域被 DB 守卫拒。
- **线上 UI E2E**：登录态单图下载 GET 200、ZIP POST 200 触发浏览器下载、Package 2 源弹 Quark/Baidu 选择器；游客显示"下载需登录"+"登录后可获取网盘下载链接"。
- **坑**：① PostgREST to-one embed 是对象不是数组（`img.asset_languages` 直接取，勿 `[0]`）；② 0003 Publish 守卫会拦"INSERT 直接 published"，播种脚本须先 draft 再 PATCH 发布；③ 清理脚本按 name 匹配漏删（演示资产 name='Download Demo'、slug 才是 dl-demo-*），按 id 兜底删。
- **文件名保留（Owner 复核项，已线上验证 ✅）**：单图走 Worker 302→public URL，**Supabase public 对象 GET 不返回 Content-Disposition（实测 null）**，故 302 上设的 CD 不会附着到被重定向后的响应。真正保住原始文件名的是**前端**：`fetch` 跟随 302 取 blob 后以 `a.download = img.filename`（DB 原始名）命名；`filenameFromResponse` 因重定向响应无 CD 而正确回退到原始名。ZIP 路径是 Worker 直接 200 流（非重定向），其 `Content-Disposition: {slug}-{lang}.zip` 正常生效。→ 结论：行为正确，无返工；上一版报告"CD 由 Worker 侧给"表述不严谨，以本条为准。
- **Git**：Phase 5 commit 已推 main。

---

## 五、待 Owner 配合 / 当前挂起事项

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| **邮箱验证开关** | ✅ 看起来已关闭 | Phase 2 线上实测：注册 `weaktest@example.com` 后**直接返回 session**（未出现"查收邮件"分支），说明 Confirm email 已被关闭。注册页的"待验证"分支代码保留，随时兼容重新开启 |
| Worker Secret 注入 | ✅ 已注入 | Phase 3 已 `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`（Storage 删除端点使用）；本地 `worker/.dev.vars` 同步更新 |

---

## 六、下一步任务：Phase 6 — Search & Tags（未开始）

按 `【分阶段】` 文档执行。**开工前先输出 Phase 开始报告（Design Gate）**，完成后对照 Gate G6 验收。

### Phase 6 概要
搜索（关键词匹配 Asset）+ Tags（属于 Asset 的多对多标签，`tags`/`asset_tags` 表已在 0001 建好，写策略 admin-only）。注意：Tags 属 Asset 级，不绑 Image；搜索/筛选走 `published_assets` 视图 + RLS，**继承双层可见性铁律，不重发明**。

### 后续 Phase 概要（详见分阶段文档，勿跳级）
Phase 6 搜索+Tag → 7 Admin 控制台 → 8 安全加固 → 9 UX/性能 → 10 发布。

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
