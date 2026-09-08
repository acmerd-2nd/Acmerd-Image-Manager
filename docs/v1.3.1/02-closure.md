# V1.3.1 收口报告 — Feature Optimization & UX Fix（CLOSED）

> 日期：2026-09-08 · 提交：`7d24882`（feat）· 生产 Worker ver **`efb2c05d`**（bundle `index-CjQn1Bce.js`）· 迁移 **0001–0017** 全 applied · 回滚锚点 `85180f65`
> 需求来源：Owner `v1.3.1优化方案.txt`（正式 Change Request）→ Design Gate（`docs/v1.3.1/01`，Owner「全按建议，批准开工」）→ 实施 → 生产回归 → 本收口。

## 一、Implemented（对照 CR）

| CR 需求 | 落地 |
| --- | --- |
| §1 排期三状态 | 0017 `schedule_items.progress`（CHECK：not_started/in_progress/completed，default not_started）；前台 🟢🔵🔴 圆点 + completed 灰色删除线（不隐藏）；`published_schedule_items` 视图增列 progress（不含 status，正交） |
| §1.5 Admin 改状态 | AdminSchedulePage 每行三段式控件（彩点+标签），Worker PATCH 校验 progress 白名单，双端实时生效 |
| §2 合集封面 | **补齐缺失写入链路**：Worker PATCH 收 `cover_image_id`（uuid|null）；Admin 封面管理卡（无封面虚线空态「设置封面」/ 封面预览「更换/移除」）；可视化选图 Dialog（仅本合集成员资产缩略图，CR §2.4）；`collection.noCover` 前台卡文案（高度不变，CR §2.6）；DB 守卫 `COLLECTION_COVER_MISMATCH` 原样保持（CR §2.3） |
| §5 Set Balance 语义 | delta 流水（admin_adjustment，amount=±、from/to、metadata.operation='set_balance'），从不直改 balance；成功 Toast + 列表即时刷新；失败 Toast + 错误可见（CR §5.2/5.3） |
| §6 Unlimited | BUG-A 修复：Worker PATCH 命中 0 行 → 404 `credit_account_missing`（原为 200 静默 no-op）；开关不改 balance；免确认 + Toast（CR §10） |
| §7 快捷加分 | Dialog 内 +10/+50/+100 点击即生效；语义=当前余额+delta（42→92）；metadata.operation='quick_add'；−10/−50 折叠在「负调」内、余额不足自动禁用（CR §14） |
| §8 批量调整 | 新端点 `POST /api/admin/users/credits/batch`（requireAdmin；user_ids≤100 去重、delta 非零、reason 必填）→ RPC `admin_batch_adjust_credits`（**方案 A：整批成功或整批失败**，两段式 FOR UPDATE，任一失败整体回滚）；前端复选 + 批量条 + 二次确认 |
| §9 Users 列表 UX | 列：选择框/用户/角色/Credits(♾)/Unlimited 徽标/创建/状态/⋯菜单；操作收敛 ⋯ dropdown（调整积分/角色/禁用·启用） |
| §10 确认规则 | ±快捷免确认；Set Balance 二次确认「从 X 改为 Y?」；Delete 用户功能不存在（后端无此端点，未新增） |
| §12 成本预显示 | 单图 hover 成本 chip「N 积分」、ZIP 底条、Package 按钮均显示费用；unlimited 用户一律 ♾（含补上 CreditsBadge 缺失的 `credits.unlimitedShort` 键） |
| §13 原因字段 | Set Balance Reason 必填（≤200），入 ledger reason；批量同 |
| §16 安全 | 零 RLS 改动；批量/快捷均走 Worker→authorized RPC；未登录调批量=401（生产实测）；allowlist 43 不变（复用 credits.adjusted / credits.unlimited_changed） |
| §15 非目标 | 未做充值/支付/券/过期/商城/转赠；未重构无关页面 |

## 二、审计结论（Gate 修正留档）

- **后端积分链路无 Bug**（生产实测 Set Balance 100→95→100、Unlimited ON/OFF 全 200 + DB 正确）。根因 = UX：余额「点击数字」无编辑入口标识、无成功 Toast、错误在远端顶部 banner。
- **BUG-A（真）**：unlimited PATCH 0 行静默 no-op → 已修 404。
- **BUG-B（证伪）**：Gate 曾判「新用户缺 credit_accounts 行」——实施期冒烟证明 `handle_new_user` 触发器（0010 §4）已自动建户（T4pre：3 个新建测试用户全部自动建户 balance=0）。当初 admin 缺行是**早于触发器上线的存量缺口**，已手工补建。Gate 文档已更正。

## 三、Database / Files

- **迁移 0017**（生产 applied 2026-09-08）：progress 列 + CHECK + `published_schedule_items` 重建 + `adjust_credits` 5 参（p_operation，旧 4 参 drop）+ `admin_batch_adjust_credits`（SECURITY DEFINER，方案 A 原子）。
- 主要文件：`worker/index.ts`（schedule progress 校验、BUG-A、operation、cover_image_id、batch 端点）、`AdminUsersPage.tsx`（重构）、`CreditsAdjustDialog.tsx`（新）、`AdminCollectionsPage.tsx`（封面管理卡+选图）、`AdminSchedulePage.tsx`/`SchedulePage.tsx`、`AssetDetailPage.tsx`/`PackageDownloadPanel.tsx`（成本标签）、`CollectionCard.tsx`、`features/{admin,collections,schedule,downloads}/api.ts`、`types/database.ts`、`i18n/{zh,en}.ts`（admin.credits.*/admin.usersPage 批量/collections 封面/schedule 进度/unlimitedShort）。

## 四、Tests / 生产回归证据

| 层 | 结果 |
| --- | --- |
| 0017 隔离冒烟 `scripts/v131-smoke.mjs` | **16/16**（progress 默认/CHECK/切换、视图暴露+正交、adjust+p_operation、触发器自动建户、批量成功+原子性 3 例零残留、无 claim FORBIDDEN、视图列序+allowlist） |
| typecheck + build | SPA + Worker TS 0 错误；vite build 绿 |
| 评审代理 | 修复 3 项：确认框遮罩冒泡连带关闭 Dialog、批量确认文案原始输入（`+50`→`++50`）、末行 ⋯ 菜单被裁剪（末行改向上弹） |
| 生产结构 `scripts/v131-prod-verify.mjs` | **8/8 PASS**（列+default、CHECK、视图列、两 RPC 签名、schema_migrations 0017、存量行默认 not_started、allowlist 含 credits.*） |
| 生产门禁 | 未登录 `POST /api/admin/users/credits/batch`=401；`PATCH /api/admin/schedule-items/:id`=401；线上 bundle=`index-CjQn1Bce.js`，AdminUsersPage chunk 含 quick_add/credits/batch 标记 |
| 生产 RPC 实测 `scripts/v131-prod-rpc-test.mjs` | adjust_credits(set_balance) + batch(+3) 事务内 ledger 正确（operation=set_balance/batch），**ROLLBACK 后零残留**（余额复原、0 条残留流水） |
| 前台抽查（浏览器） | `/schedule` 显示「未开始」进度标签（新前端已生效）；explore 无已发布合集 → 空态正常（CR §2.7） |

**待 Owner 走查（需登录态，1 分钟级）**：Admin 排期改状态 → 前台变色；Admin 合集设置/更换/移除封面；Admin 用户调整积分（快捷/Set Balance/Unlimited）→ 刷新仍正确；批量调整。

## 五、安全与红线核查

未触碰：RLS、`makeImageUrl` 唯一出口、`/asset/:slug`+`/collection/:slug` 语义、Storage originals、audit allowlist（43）、service_role 仅 Worker Secret。Secret 扫描面无新增密钥。批量端点 requireAdmin + RPC 内 FORBIDDEN 双保险（service_role 或 is_admin）。

## 六、Gate Status：**CLOSED**

V1.3.1 全链完成。遗留开口（继承 V1.2/V1.3）：邮件闭环验证（暂缓）、生产 registration_enabled 默认关闭（可选）。
