# V1.1 生产部署步骤与回滚预案

> 状态：🟡 **PENDING——两项前置未满足：① Owner 终验 V1.1 Phase C；② 部署显式授权**（批准前零执行）
> 编制：2026-09-06　依据：wrangler.toml（单 Worker 承载 SPA+API）、`package.json#deploy`、远端真理源 `git ls-remote`
> 三态：本文全部为**计划**；截至编制时未 push、未 deploy、生产零改动。

---

## 0. 部署形态（事实基础）

- **单 Worker 原子发布**：`npm run deploy` = `vite build`（产出 `dist/`）+ `wrangler deploy`（Worker 代码 + `[assets] dist` + cron `*/10 * * * *` 一次带走；自定义域 `image.acmerd.com`）。无蓝绿/分批，发布即全量，秒级生效。
- **数据库：本次部署零迁移**。0001–0014 全部已 applied（Phase A/B 完成）；PC-5/PC-6/PC-7 明确零 schema、零新 RPC。部署纯代码。
- **Secrets：零新增**。`GITHUB_TOKEN`、`SUPABASE_SERVICE_ROLE_KEY` 已在 Worker Secret（Phase B 起生效）；`[vars]` 已是生产仓 `acmerd-2nd/-Photo-Acmerd-Image-Manager`。
- **本次变更内容**（远端 `main=f68a866` → 本地 `ac7a873`，12 个 commit）：PC-4 Credits 扣分接线、PC-5 注册 Gate、PC-6 平台控制 + seed 用户（seed 已在生产建号）、PC-1~3 i18n/Collection/Schedule、PC-7 回归证据。详见 `12-pc7-regression-report.md`。

## 1. 部署前检查单（P0→P3，逐项过）

| # | 项 | 状态/动作 |
| --- | --- | --- |
| P0-1 | **Owner 终验 V1.1 Phase C 通过** | ⬜ 未做（当前 STOP 点） |
| P0-2 | **`.env` 补齐 `VITE_GITHUB_IMAGES_OWNER/REPO/BRANCH`**（缺则构建产物 raw URL 空 owner/repo，GitHub 图全挂） | ✅ **已修复并重建核验**（本机 `.env`，gitignored；`dist` 已验证烘焙 `acmerd-2nd/-Photo-Acmerd-Image-Manager`） |
| P1-1 | `git ls-remote origin main` 确认远端仍为 `f68a866`（唯一真理源，防分叉） | ⬜ 部署当天执行 |
| P1-2 | **push 授权**（12 个本地 commit → 远端；红线：仅 Owner Web UI 或显式授权） | ⬜ 待 Owner |
| P1-3 | **记录当前生产版本号**：`npx wrangler versions list`（回滚锚点，见 §4） | ⬜ 部署前执行 |
| P2-1 | 本地全量预演：`npm run preview`（= build + wrangler dev :8787）后按 §3 抽查 5 项 | ⬜ |
| P2-2 | 确认 `registration_enabled` 期望值：当前生产=true（开放注册）。若你想默认关闭，**部署前/后**在 Admin 平台控制关掉即可（即时生效，与部署解耦） | ⬜ Owner 决定 |
| P3-1 | typecheck + build 绿（最后一次） | ✅ 最近一次全绿（PC-7） |

## 2. 部署步骤（授权后，按序执行）

1. `git ls-remote origin main` → 确认 `f68a866` 未被他人推进；若有分叉先停下对齐。
2. （获授权后）`git push origin main` —— 12 个 commit 上远端。
3. `npx wrangler versions list` → 记下**当前生产 version id**（回滚锚点；写入部署记录）。
4. `npm run deploy` —— build + deploy 一体；观察输出 version id 并记录。
5. 立即执行 §3 验证清单；任何一项不符 → 直接触发 §4 回滚，不带侥幸。

## 3. 部署后验证清单（逐项 PASS 才算部署完成）

| # | 检查 | 预期 |
| --- | --- | --- |
| V1 | `GET https://image.acmerd.com/api/health` | 200 |
| V2 | 首页 `tu1.jpg` 图片实际加载（provider=github → raw 直链 200；F12 Network 无 404） | 图片可见 |
| V3 | 资产详情 `/asset/ecosonique` 渲染 + `?lang=en` 回跳兼容 | 正常 |
| V4 | demo01@acmerd.com 登录 → 单图下载 302 → credits 1→0（余额徽标同步） | 扣分正确 |
| V5 | 同一下载重复点击（同幂等 key）不重复扣（H2） | 余额不变 |
| V6 | ZIP 下载扣 N×单价；Package 402 路径（余额不足时） | 符合冻结语义 |
| V7 | `/register`：注册可用（开关开）；Admin 关开关后提交 → 403 提示"暂未开放注册" | gate 生效 |
| V8 | Admin 平台控制：改价 → 立即反映到下载按钮成本透出 | 即时生效 |
| V9 | Admin 审计日志：出现 `credits.*` / `settings.updated` 新行 | 审计在位 |
| V10 | seed 用户 demo01–08 在 Admin Users 列表正常、role=user | 与 PC-6 回验一致 |

## 4. 回滚预案（按故障面分层，先 A 后 B）

**A. Worker 版本回滚（首选，秒级，覆盖代码+静态资源+cron）**
- `npx wrangler rollback`（按提示选 §2 第 3 步记录的**部署前 version id**）。
- 效果：整站回到部署前形态；**无需动数据库**（本次零迁移，新旧代码共用同一 0001–0014 schema——Credits/注册 Gate 的表和 RPC 早已在库，旧代码不读不写即无害）。
- 回滚后复跑 §3 的 V1/V2/V10 确认恢复。

**B. 代码回滚（A 不可用时的兜底）**
- `git checkout f68a866 -- .`（或对应已知良好 tag/commit）→ `npm run deploy` 重新发布旧代码。
- ⚠️ 注意：回滚 checkout 须用 `git switch -c rollback/<ts> f68a866` 新分支方式，避免污染 main 工作区；完成后切回 main。

**C. 配置面回滚（与部署无关的独立开关）**
- `site_settings`（注册开关/三价格/排期开关）：Admin 平台控制即时改回，无需任何部署。
- seed 用户：无"回滚"概念（永久数据）；如需停用某 demo，Admin Users 禁用即可。

**D. 数据面回滚（本次不适用，留档规则）**
- 本次部署**零迁移** → 无 down-migration 需求。若未来带迁移部署：迁移必须可逆（提供 down SQL）或只加不改；扣分流水 `credit_transactions` 为 append-only，任何回滚**不得删流水**，纠错走 `adjust_credits` + `credits.adjusted` 审计。

**E. 凭据/Storage 红线（任何回滚路径都不得触碰）**
- `GITHUB_TOKEN` / `SUPABASE_SERVICE_ROLE_KEY` 不轮换、不删除；Supabase Storage 原件 `01-15822bee.jpg` 永不清理（Owner 未授权）。

## 5. 已知风险与既定口径（继承，不在本次解决）

- raw.githubusercontent.com 大陆可访问性（R1）：`VITE_GITHUB_IMAGE_CDN_BASE` 已预留 CDN 切换口，改环境变量整体切换、零数据迁移。
- GoTrue 公开 signup 可被 anon key 直连绕过（PD-3 已批 A，记录在案）；绝对关闭需 Supabase Auth 侧配置（单独授权）。
- 下载扣分与 302 之间进程死亡 → ledger 人工 refund 兜底（§9.1 既定，不建自动补偿）。

## 6. 执行记录（部署时回填）

- [ ] 终验通过时间 / 授权方式：
- [ ] push commit 范围 / 远端 hash：
- [ ] 部署前 version id（回滚锚点）：
- [ ] 部署后 version id：
- [ ] §3 十项验证结果：
- [ ] 回滚预案未触发 / 触发原因与时间：
