# 🔄 HANDOVER — ACMERD Image Manager 交接文档

> **最后更新**: 2026-09-08（**V1.4 站点品牌可配置 CLOSED**：生产 Worker ver `b10be398-…`，bundle `index-LDC4ezwS.js`，迁移 0001–0019 全 applied + 0019 种子已应用）
> **当前状态**: ✅ **V1.0/V1.1 冻结基线未破坏** · 🟢 **V1.2 A/B/C/D 全部 CLOSED**（D12 终裁：维持 raw）· 🟢 **V1.3 积分流水页 CLOSED** · 🟢 **V1.3.1 + 走查跟进 CLOSED**（排期三状态/封面 UX/积分修复+快捷+批量/Switch/管理员备注；回滚锚点 `85180f65`）· 🟢 **V1.4 站点品牌可配置 CLOSED**（生产 ver `b10be398-…`，0019 已应用，生产验证 11/11 PASS）· 远端 main 与本地一致（待 Owner 授权 push）
> **线上**: https://image.acmerd.com 运行中（`/api/health` 200；迁移 **0001–0019** 全 applied）
> **Truth Source**: 本地 main 含 V1.4 全部（HEAD 含 V1.4 实现 `456abab` + wrangler `run_worker_first` 修复 + 收口文档 `docs/v1.4/02`）；**push 待 Owner 授权**（授权仅含迁移+部署+验证）；V1.4 收口 = `docs/v1.4/02`
> **V1.2 证据链（`docs/v1.2/01…04`，全链 CLOSED）**: 01 Design Gate（D1–D12 Owner 全批）→ 02 CDN 评估（jsDelivr 不可行；Owner 终裁维持 raw）→ 03 部署记录 → 04 收口报告
> **V1.3 证据链（`docs/v1.3/01`）**: Change Proposal（C1–C5 Owner 全批）→ §9 执行记录回填（CLOSED）
> **V1.3.1 证据链（`docs/v1.3.1/01…03`，全链 CLOSED）**: 01 Design Gate（G1–G6 Owner「全按建议」批；含 BUG-B 证伪更正）→ 02 收口报告（冒烟 16/16 + 生产结构 8/8 + RPC 回滚实测零残留）→ 03 走查跟进（0018 冒烟 13/13 + UI 走查）

> ### 🟢 V1.3.1 当前态（2026-09-08）— 新 Agent 必读
> - **CR 来源**：Owner `v1.3.1优化方案.txt`（体验优化+缺陷修复，非重构）。Gate `docs/v1.3.1/01`（G1–G6 Owner 全批）；收口 `docs/v1.3.1/02`。
> - **0017（生产已 applied）**：`schedule_items.progress`（CHECK 三态，default not_started）+ `published_schedule_items` 增列（不含 status）+ `adjust_credits` 5 参（p_operation→ledger metadata.operation；旧 4 参 drop）+ `admin_batch_adjust_credits`（**整批成功或整批失败**，两段式 FOR UPDATE）。
> - **G1 排期**：前台 🟢🔵🔴 + completed 删除线置灰；Admin 三段式改状态，双端同步。
> - **G2 封面**：Worker PATCH 收 `cover_image_id`（此前**无任何写入链路**）；Admin 封面管理卡 + 可视化选图（仅本合集资产）；DB 守卫 `COLLECTION_COVER_MISMATCH` 不变。
> - **G3/G4 积分**：审计证明后端链路无 Bug，根因=UX（点击数字无标识、无 Toast）；BUG-A 已修（unlimited PATCH 0 行→404 `credit_account_missing`，原静默 no-op）；BUG-B **证伪**（`handle_new_user` 触发器 0010 §4 自动建户）。新 `CreditsAdjustDialog`（快捷 ±10/50/100、负调折叠、Set Balance+Reason+二次确认、Unlimited Toast）+ `POST /api/admin/users/credits/batch`（≤100、reason 必填）+ 用户页复选批量条。
> - **G5/G6**：用户操作列 ⋯ 菜单（末行向上弹防裁剪）；下载三处成本标签（N 积分 / ♾ unlimited；补 `credits.unlimitedShort` 键）。
> - **生产回归**：结构 8/8（`scripts/v131-prod-verify.mjs`）+ RPC 回滚实测零残留（`scripts/v131-prod-rpc-test.mjs`）+ 未登录 401 门禁 + 前台排期进度已生效。冒烟 `scripts/v131-smoke.mjs` 16/16。
> - **走查跟进（2026-09-08 晚，CLOSED，`docs/v1.3.1/03`）**：Owner 反馈「无法改积分/无法开无限积分」真根因 = 0012 `credit_accounts` SELECT 策略漏 admin 分支（admin 客户端只读到 1 行 → 积分列 `—`、调整按钮灰、Dialog 打不开；Worker 开关链路实测健康）→ **0018** 修为 own-or-admin（只读放宽；写仍 Worker 独占）+ `user_admin_notes` 管理员备注（RLS 仅 is_admin + 审计 `users.notes_updated`，allowlist 43→44）。前端：苹果 Switch（`ui/switch.tsx`；列表 Unlimited 列直接可切 + Dialog 内）+ ⋯菜单「备注」（`UserNotesDialog`）。冒烟 `v1311-smoke.mjs` **13/13**；生产验证：admin 读 9 行、开关回环 200、备注回滚零残留、UI 走查「调整积分」不再置灰 + demo01 开关 Toast 回环。
> - **待 Owner 走查（登录态）**：批量调整走查；其余项已由 Agent UI 走查覆盖。

> ### 🟢 V1.4 当前态（2026-09-08）— 新 Agent 必读
> - **Gate 来源**：`docs/v1.4/01-design-gate.md`（Owner 裁决落档）；收口 `docs/v1.4/02-implementation-report.md`。
> - **范围（零 schema/RLS/Storage/allowlist 变更）**：在 0011 `site_settings` KV + 0014 GitHub 图床通道之上新增可配置品牌——`brand_text`（导航文字）/ `brand_title`（浏览器标题）/ `brand_logo_path`（Logo，存 GitHub 图床 `branding/logo.<ext>`）。
> - **0019（生产已 applied）**：`site_settings` 幂等种子 3 brand 行（默认 `brand_text`/`brand_title`="ACMERD · 探知"、`brand_logo_path`=""）。`schema_migrations` 记账因 service_role 无 INSERT 被拒 → **仅缺记账、数据已正确落地**，DNS 恢复后 `db:migrate` 自愈。
> - **Worker**：`SETTING_KEYS` 扩 3 brand key（5→8，allowlist 不变）；PATCH 字符串校验含 brand 三键；`POST/DELETE /api/admin/branding/logo`（`requireAdmin`，复用 `ghPutFile/ghDeleteFile/computeGitBlobSha`）+ `BRANDING_MAX_FILE_SIZE` + 扩展名/MIME/体积校验；审计动作 `settings.updated`（元数据含 `previous_path`/`github_deleted`/`brand_logo_path`）。
> - **前端**：`BrandingCard`（AdminDashboardPage）+ `AppShell` 导航/标题动态渲染（`document.title` 取 `brand_title`）+ `brandLogoUrl()`；i18n `admin.brand.*` 同构键。
> - **部署回归修复（关键）**：wrangler 4.4→4.128 默认 `run_worker_first` 翻为 false（assets-first）→ 首轮部署 `/api/*` 全 404 落 SPA 回退。修复：`wrangler.toml [assets]` 显式 `run_worker_first = true` + 重部署；验证无 token `/api/health`=200、`/api/admin/settings`=401 JSON（Worker 接管）。**此修复独立 scoped commit**。
> - **生产验证**：`scripts/v14-prod-verify.mjs` **11/11 PASS**（admin 登录→PATCH 品牌→anon 直读反映→还原→上传 1x1 PNG logo→GitHub 仓出现→DELETE→清空+审计命中）；生产残留 = 默认（brand_text/title="ACMERD · 探知"、logo 空、GitHub `branding/` 空）。
> - **线上**：Worker ver `b10be398-d2c0-4e9a-8ad4-90b444a412b8`（100% 流量，2026-09-08T07:06Z）；回滚锚点 = 前一部署 `8d214ddf-9c54-422a-a7ac-3e899d785aed`（`wrangler rollback` 整体回退，无需动库）。
> - **待 Owner 决定**：本 Agent 收尾 **push 已完成**（2026-09-08 Owner 授权，可靠模式 `48577dc..7fdffdb` 推 origin/main；git ls-remote 复核一致）；其余开口同 V1.3.1（邮件闭环暂缓 / registration_enabled 默认）。

> ### 🟢 V1.2 当前态（2026-09-07）— 新 Agent 必读
> - **A 多层 Folder（CLOSED，35f9c10）**：0015 = `collections.parent_id`（自引用 FK RESTRICT）+ 守卫触发器（自引用/环/深度≤5/子树随迁溢出）+ `published_collections` 递归链重建（全链 published 才公开；`asset_count` 仍只数直接子资产）；Worker create/patch `parentId` + 删父预检 409 `collection_has_children` + guard 400 映射；Admin 树形 + 父级选择器、首页仅根级、详情页面包屑+子合集卡。冒烟 13/13（曾抓出守卫 2 个真 bug 已修）+ 沙箱 13/13。
> - **B Schedule 编排（CLOSED，7d92c2c）**：0016 = `schedule_items` + 4 RLS（镜像 0012）+ `published_schedule_items` 视图（event_date asc nulls last）+ 审计 5 动作 + allowlist 38→43；Worker `/api/admin/schedule-items` CRUD；AdminSchedulePage（侧栏+路由）；公开页真实渲染、空态回 Coming Soon。冒烟 10/10 + 生产 e2e 6/6 零残留。
> - **C 密码找回（CLOSED，94b1d56）**：`/reset-password` + `/reset-password/confirm`（GoTrue 原生流，redirectTo 仅同源常量）；D10①② Owner 已配（Site URL + redirect allowlist）；**邮件闭环验证 Owner 明示暂缓**（需真实收信邮箱；内置 mailer 限速 ~2 封/小时，SMTP=D10③ 可选后补）。
> - **D R1 CDN（CLOSED）**：实测 jsDelivr `gh/` 面已整体 301→raw（连 jquery@tag 也如此）→ 零加速收益；**Owner 终裁「维持 raw」，R1 关闭**（`docs/v1.2/02` 终裁注记；`VITE_GITHUB_IMAGE_CDN_BASE` 切换口保留备用）。
> - **事实更正留档**：0009–0014 在 `schema_migrations` 原无记录（V1.1 经其他通道应用）；2026-09-07 migrator 幂等重放并补记，核验零副作用。
> - **待 Owner（当前开口）**：① 邮件闭环验证（暂缓，需收信邮箱）+ SMTP 可选；② 生产 `registration_enabled` 默认关闭（Admin 一键）；③ 后续需求未发起。
> - **环境坑（更新）**：全局 npx/npm 仍坏（一律 `node node_modules/wrangler/wrangler-dist/cli.js …`）；本机 Node 到 raw 出网受限（W0f 判别口径不变）；**2026-09-07 下午曾发 DNS 故障**——`db.*.supabase.co` ENOTFOUND + pooler tenant 异常（WARP/IPv6-only 环境），隔离冒烟/生产 DDL 会间歇不可用，重试等待即可恢复。

> ### 🟢 V1.1 当前态（归档快照，2026-09-06）
> - **Phase C 全部完成**：PC-1 i18n（zh/en 全量接线，`uiLocale`≠`assetLang`）/ PC-2 Collection UI / PC-3 Schedule / **PC-4 Credits 扣分接线**（单图/ZIP/Package 三链路 × 0010 RPC，沙箱 31/2——2 FAIL=W0f 本地 Node raw 出网受限，Owner 已裁决豁免关 Gate，W7 ZIP 200 反证 raw 可用）/ **PC-5 注册 Gate**（Worker `POST /api/auth/register`，前端改投，E2E 建号→登录闭环）/ **PC-6 Platform Controls + Seed**（demo01–08@acmerd.com 已建产，凭据文件交 Owner 落 `G:\000000.AIDIJIA`）/ **PC-7 集成回归 PASS**（沙箱 + zh 走查 12 路由 + 红线 grep + 零残留）。
> - **生产部署（Owner 授权本机执行）**：ver `18941cbc` → `71278568`；P0 阻断项（`.env` 缺 `VITE_GITHUB_IMAGES_*` → 烘焙空 owner/repo）部署前抓到并修复；线上验证：`scripts/v11-pc7-prod-verify.mjs` **16 PASS/0 FAIL/1 SKIP** + 浏览器 tu1.jpg 200。routes 步 10000 报错 = cosmetic（既知）。
> - **V1.1 冻结不变量（新增，叠加在 V1.0 之上）**：Credits H2 幂等三态 + C6 无负余额 + 一 debit 一 refund + unlimited 旁路；注册 gate 服务端 fail-closed（GoTrue anon 直连 signup 旁路 = 已批残余风险 PD-3 A）；GitHub path `assets/{asset-uuid}/{langCode}/{file}`；`images.status` 四态；`makeImageUrl` 唯一 URL 出口（V1.0已有，V1.1强化验证）；seed 用户 `account_origin='seed'` 仅标识无特权。
> - **待 Owner 决定（当前唯二开口）**：① 生产 `registration_enabled` 现为 true（开放注册）——要默认关闭去 Admin 平台控制一键（与代码无关）；② Phase D / 后续需求未发起。
> - **环境坑（本会话实证，接手必读）**：本机**全局 `npx`/npm 已坏**（`AppData\Roaming\npm\...\npx-cli.js` 缺失）→ 跑 wrangler 一律 `node node_modules/wrangler/wrangler-dist/cli.js …`；本机 Node 到 `raw.githubusercontent.com` 出网被阻（浏览器正常）→ 沙箱 W0f 类 raw 轮询必 FAIL，判别口径=W0f FAIL + W7 ZIP 200 ⇒ 环境非对称非缺陷；本机无本地 Postgres 且 `db.*.supabase.co:5432` DNS ENOTFOUND → 隔离库冒烟无法复跑（历史证据 48/48、16/16、13/13 代位，有环境可补跑）。

> ### 📌 Owner 正式声明 — Frozen Production Release（2026-09-04）
> > **V1.0.0 is the frozen production release. Any post-release change must go through Change Proposal / new phase rather than modifying the release baseline in place.**
>
> **Release Governance 确认（Owner 接受）**：最终 tag `v1.0.0` 指向 `2065d44`，晚于最初冻结的 RC `131d315`——RC 之后仅有证据/文档/报告类变更（无运行时代码变更），**最终运行代码与 RC 一致**，已由 bundle hash（`index-DosBFCeX.js` 重建同源）+ Worker identity（`94cb46b3`）+ 迁移状态（0001–0008 全 applied）三重对应证明。V1.x backlog 见 `docs/phase-10/03-release-notes.md` §六，任何 backlog 项落地均须走新 Change Proposal / 新 Phase。

---

## 零、V1.0 后接手须知（归档版）

1. **项目已发布**：Phase 0–10 全部 CLOSED。六铁律不变：两份中文规划文档 + `.workbuddy/` 不入库；Service Role Key 只进 Worker Secret/本地脚本；改设计先交 Change Proposal；未提供证据不宣布 PASS。
2. **发布身份核验**：`git ls-remote https://github.com/acmerd-2nd/Acmerd-Image-Manager.git refs/tags/v1.0.0`；bundle = `index-DosBFCeX.js`；Worker = `94cb46b3-c7b4-4c1c-878a-8e1aeb686d27`；DB = 0001–0008。
3. **冻结基础设施（永久）**：published_assets / is_admin() / RLS / audit allowlist(24) / disabled 门禁 / 双层可见性——任何变更走 Change Proposal + 新 migration。
4. **V1.x Backlog 候选**见 `docs/phase-10/03-release-notes.md` §六。

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
   - `docs/v1.1/01…13-*.md`（**V1.1 全证据链**：10 号 Phase C Gate 的 Q1–Q5 裁决 + 12 号 PC-7 回归 + 13 号部署/回滚——新需求前必读冻结不变量）
   - `【总纲1.1】v1.1.txt` + `【进度看板1.1】实时更新.txt`（V1.1 权威总纲与实时看板，本地文件不推公开仓库）
2. **确认密钥就位**：项目根 `.env` 必须存在（键名见第二节）。若新机器没有 `.env`，**必须找 Owner 索取原文件**——所有密钥都只在 `.env`，无法从别处重建。`.env` 已被 `.gitignore` 排除，**绝不提交**。
3. **确认工具链**：bash 会话中 `node`/`npm` 可直接用（受管 Node v22）。若 npm 解析失败，回退 `/d/node/npm.cmd`（历史已知可用 Node v24）。`python` 可直接用（受管 3.13）。
4. **验证环境健康**（只读，安全）：
   ```bash
   git log --oneline -3          # 应见 V1.3.1 收口 commit（2026-09-08）
   npm run typecheck             # 前后端 TS 0 错误
   curl -s -o /dev/null -w "%{http_code}\n" https://image.acmerd.com/api/health   # 200
   npm run db:migrate            # 全部 skip（幂等）即 DB 状态正确
   ```
5. **确认 DB 状态**：`supabase/migrations/` 有 **0001–0018**（V1.1/V1.2/V1.3.1+跟进 全部已 applied），`schema_migrations` 全记录。**不要在 Supabase Dashboard 手改生产库**——结构变更只许新增 `supabase/migrations/XXXX_*.sql` 后跑 `npm run db:migrate`。
6. **确认 V1.2/V1.3/V1.3.1 现状**：均生产运行（ver `ad5dfa69`，远端 main 同步）。待 Owner 决定项见「第六节」。**严禁在未获 Owner 裁决前实施任何新需求/新代码。**

**关键红线（违反会被 Owner 打回）**：Service Role Key 只进 Worker Secret / 本地脚本，绝不进前端 bundle / Git / wrangler.toml；权限只靠 UI 隐藏无效，必须 RLS/服务端兜底；改设计先交 Change Proposal；两份中文规划文档 + `.workbuddy/` 不推公开仓库；**未提供证据前不得宣布 Gate PASS**；不扩大 Scope、不重构已完成 Phase。

### 当前状态快照（2026-09-08，V1.3.1 收口后）
| 维度 | 值 |
| --- | --- |
| HEAD / 远端 | `73e5aab`（走查跟进）之后随 docs commit 同步 origin/main |
| 生产 Worker | ver `b10be398-d2c0-4e9a-8ad4-90b444a412b8`（2026-09-08 部署；run_worker_first=true 修复；回滚锚点 `8d214ddf-9c54-422a-a7ac-3e899d785aed`；bundle `index-LDC4ezwS.js`） |
| 工作树 | 未跟踪：`.workbuddy/`、`.qoder/`、规划文档 + 总纲1.1/看板1.1 [故意不推]；已提交 V1.4 全部代码+文档，**push 待 Owner 授权** |
| 已应用迁移 | 0001–0008（V1.0）+ 0009–0014（V1.1）+ 0015–0016（V1.2）+ 0017（V1.3.1）+ **0018（走查跟进）** + **0019（V1.4 品牌种子：site_settings 3 brand 行，幂等）** |
| Worker 端点 | V1.0–V1.3.1 全量保留。全部经 `authenticate()` |
| Worker Secret | `SUPABASE_SERVICE_ROLE_KEY` 已 `wrangler secret put`；本地 `worker/.dev.vars` 同步 |
| 管理员账号 | `1902768564@qq.com`（密码见 `.env` 的 `ADMIN_PASSWORD`），角色 admin |
| 冻结基线 | 双层可见性（Asset+Language published，0007 后语义经 NO-DRIFT 证明未漂移）、多语言模型、三套下载解耦、ZIP ≤30/≤100MB/并发4、public bucket（残余风险已记录，见 D5/5a）、audit allowlist=44、last-admin 原子保护、disabled 门禁对偶（Worker 403 + RLS `is_admin` 含 `disabled=false`） |
| 数据现状 | 生产库极小：1 asset（Ecosonique）/1 image（tu1.jpg, provider=github）/0 tags/0 collections/1 schedule_item（progress=not_started）+ **seed 用户 demo01–08@acmerd.com（user 角色，余额 0）+ admin**。admin 有 credit_accounts（0 余额）+ V1.3/V1.3.1 验证调分行（生产 RPC 回滚实测零残留）。大列表/分页/层级验收仍须在隔离库造数，不许拿生产小数据集充数 |

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

## 六、当前待办（2026-09-08 更新）

**已全部完成**：V1.0（Phase 0–10）；**V1.1 全链**（`docs/v1.1/01…13`）；**V1.2 全链**（`docs/v1.2/01…04`，含 D12 终裁「维持 raw」）；**V1.3 积分流水页**（`docs/v1.3/01`，C1–C5 全批 → 实施 → 部署 ver `85180f65`）；**V1.3.1 全链 + 走查跟进**（`docs/v1.3.1/01…03`：排期三状态 / 合集封面 UX / 积分修复+快捷+批量 / 苹果 Switch / 管理员备注；生产 ver `ad5dfa69`，迁移 0001–0018）。

**V1.4 站点品牌可配置（CLOSED）**：代码 + 0019 迁移本地提交（HEAD `456abab`）+ wrangler `run_worker_first=true` 部署修复；Worker 已部署 ver `b10be398-…`；0019 种子已应用（site_settings 3 brand 行，默认态）；生产功能验证 `scripts/v14-prod-verify.mjs` **11/11 PASS**；收口 `docs/v1.4/02-implementation-report.md`。详见下方「🟢 V1.4 当前态」。

**当前开口（均 Owner 决定，Agent 不得擅自推进）**：
1. **邮件闭环验证（Owner 明示暂缓）**：需 1 个真实可收信邮箱；SMTP（D10③）可选后补（内置 mailer 限速 ~2 封/小时）。
2. **生产 `registration_enabled` 现为 true**。若要默认关闭：Admin Dashboard → 平台控制一键（即时生效）。
3. **后续需求未发起**。任何新需求走 Change Proposal → 新 Phase/版本流程（惯例：Gate 落 `docs/vN.N/NN`，Owner 逐项裁决后才动代码）。

**技术债/留档事项（非阻塞）**：
- 0009–0014 曾不在 `schema_migrations`（V1.1 经其他通道应用），2026-09-07 migrator 幂等重放补记，核验零副作用——后续勿重复执行非幂等变更。
- 本机 DNS 间歇故障（WARP/IPv6-only）：`db.*.supabase.co` ENOTFOUND（该主机**纯 IPv6**，本机 IPv6 TCP 出网可能被阻）+ pooler 全 region `XX000 tenant/user not found` 时，隔离冒烟/生产 DDL 须等待恢复（2026-09-08 实测约 1 小时后自愈）；**HTTPS 通道（Supabase REST/GoTrue）通常仍可用**，可作替代诊断（admin JWT 经 `POST /auth/v1/token?grant_type=password` 获取）。pooler 候选用户名必须 `postgres.<ref>`。
- GoTrue 公开 signup 可被 anon key 直连绕过（PD-3 已批 A，记录在案）。
- wrangler deploy routes 步 10000 报错 = cosmetic（token 缺 zone routes 读权限；消除需 Owner 在 CF 补权限）。

**验证脚本索引（可复跑）**：V1.1 = `scripts/v11-pc4-sandbox.mjs`（PC4_BASE）、`v11-pc5-verify.mjs`、`v11-pc6-seed.mjs`（幂等 seed，勿重跑重发密码；G: 盘已不在，凭据找 Owner 重发）、`v11-pc7-prod-verify.mjs`；**V1.2 = `v12-a-folder-smoke.mjs`（隔离库 13/13）、`v12-a-worker-sandbox.mjs`（本地 worker 13/13）、`v12-b-schedule-smoke.mjs`（隔离库 10/10）**；**V1.3.1 = `v131-smoke.mjs`（隔离冒烟 16/16）、`v131-prod-verify.mjs`（生产结构 8/8 只读）、`v131-prod-rpc-test.mjs`（生产 RPC 回滚实测，零残留）、`v1311-smoke.mjs`（0018 跟进冒烟 13/13）**；**V1.4 = `v14-prod-verify.mjs`（生产功能 11/11：品牌 PATCH→anon 直读→上传/删 Logo→GitHub 仓→审计，幂等还原默认）**；V1.3 = 纯读功能，走查即可（无脚本）；证据 `docs/v1.2/`、`docs/v1.3/`、`docs/v1.3.1/`、`docs/v1.4/`。

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
├── phase-0/ · phase-7/ · phase-8/ · phase-9/ · phase-10/   # V1.0 全部归档
└── v1.1/01…13-*.md + evidence-*.md      # V1.1 证据链（12=PC-7 回归、13=部署预案+执行记录）
```

### V1.1代码地图增量（在 V1.0 基础上，2026-09-06 现状）

```plaintext
supabase/migrations/（0008–0014 为 V1.1 新增，全部已 applied）
├── 0008_search_pagination.sql      # _search_assets_core → search_assets → search_assets_paged
├── 0009_v11_foundation.sql         # collections + site_settings(5 key) + profiles.account_origin
├── 0010_credits.sql                # credit_accounts + credit_transactions + deduct/refund/adjust RPC（H2）
├── 0011_settings.sql               # site_settings anon 可读 grants + settings 审计
├── 0012_collections_rls.sql        # collections RLS（anon 读 published / admin 写）
├── 0013_audit_allowlist_v11.sql    # allowlist 扩展（credits.* / settings.updated 等）
└── 0014_phase_b_github.sql         # images provider 双模型 + 四态 + sweeper 语义

worker/index.ts                      # V1.1 新增端点（其余同 V1.0）：
                                     #   POST /api/auth/register（PC-5 注册 gate，公开，fail-closed）
                                     #   POST /api/admin/images/github-upload|github-delete（PB）
                                     #   GET/PATCH /api/admin/settings（PC-3/6，5 key allowlist）
                                     #   GET/POST /api/admin/collections…（PC-2 admin CRUD）
                                     #   下载三端点接 deduct_credits/refund_credits（PC-4）
                                     #   scheduled = reconcileSweeper（cron */10）

src/
├── i18n/{zh,en,index.tsx}           # 轻量 i18n：Dictionary 同构（const en: Dictionary）+ LocaleProvider + t()
├── components/LocaleSwitch.tsx      # 左上角 中/EN Apple 风切换（uiLocale=localStorage acmerd.ui.locale）
├── features/
│   ├── auth/api.ts                  # PC-5 registerViaWorker + RegisterError（前端不建会话）
│   ├── auth/AuthProvider.tsx        # + uiLocale 隔离；资产语言 ?lang= 语义不变
│   ├── collections/api.ts · CollectionCard.tsx    # PC-2
│   ├── credits/…                    # 余额徽标 CreditsBadge（credit_accounts RLS 自读）
│   ├── settings/api.ts              # getSiteSettings（公开只读 5 key）
│   └── admin/api.ts                 # + getPlatformSettings/updatePlatformSettings/updateUserCredits
└── routes/pages/
    ├── SchedulePage.tsx · CollectionDetailPage.tsx   # PC-3 / PC-2
    ├── RegisterPage.tsx             # PC-5 改投 Worker → signInWithPassword（PD-1 A）
    └── admin/AdminDashboardPage.tsx # + PlatformControlsCard（PC-6 A：2 开关 + 3 价格）
    └── admin/AdminCollectionsPage.tsx · SchedulePage 等 i18n 全量接线（PC-1）

scripts/（V1.1 新增）
├── v11-phase-a-smoke.mjs            # Phase A 隔离库 48/48（历史证据）
├── v11-pc2-smoke.mjs · v11-pc4-smoke.mjs
├── v11-pc4-sandbox.mjs              # PC-4 沙箱 31 项全矩阵（本地 worker + 生产 Supabase/GitHub，e2e4 前缀）
├── v11-pc5-verify.mjs · v11-pc6-seed.mjs · v11-pc7-prod-verify.mjs
└── _pc4/5/7-runner*.sh              # 临时 runner（用后即删；本机全局 npx 坏 → 走项目本地 wrangler 二进制）

关键本机文件（均 gitignored，勿回退/勿提交）：
├── .env                             # 全部凭据 + VITE_*（含 VITE_GITHUB_IMAGES_OWNER/REPO/BRANCH——缺失会导致烘焙 raw URL 空 owner/repo，P0 级）
├── .dev.vars                        # GitHub 仓配置已对齐生产仓 acmerd-2nd/-Photo-Acmerd-Image-Manager（PC-4 排障结论）
└── G:\000000.AIDIJIA\seed-credentials-*.txt  # seed 用户密码（Owner 保管，绝不入 Git/chat/文档/记忆）
```

**证据与记忆纪律**：每 Phase 的 evidence 落在 `docs/phase-X/evidence/*.md`；六类证据模板（实际 SQL / 权限验证 / 并发语义 / 门禁线上 / RLS 回归 / 前 Phase 回归）；换人衔接更新本文件 + `.workbuddy/memory/YYYY-MM-DD.md`（append-only，勿删 `.workbuddy/`）。
