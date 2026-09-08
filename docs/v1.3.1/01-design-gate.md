# V1.3.1 Design Gate — 体验优化 + Bug 修复（排期 / 合集 / Users·Credits）

> **依据**: `v1.3.1优化方案.txt`（Owner 2026-09-07 提交的 Change Request）
> **性质**: 现有功能优化 + Bug 修复 + UX 改进；**不重设计底层权限模型，不碰冻结不变量**
> **状态**: ✅ Step 1 根因审计已完成 → 本 Gate 待 Owner 逐项裁决（G1–G6）→ 未裁决不动代码

---

## §1 Step 1 根因审计结论（生产实测，非猜测）

### 1.1 「Set Balance 没有反应」「Unlimited 开关失效」——后端无 Bug

对**生产**全链逐层实测（admin JWT → Worker → adjust_credits RPC → DB）：

```
POST /api/admin/users/{demo08}/credits {balance:95}   → 200 {"ok":true,"balance":95}
POST /api/admin/users/{demo08}/credits {balance:100}  → 200 {"ok":true,"balance":100}
POST 同端点 {unlimited:true} → {unlimited:false}       → 200 ×2
DB 复核: balance=100, unlimited=false ✅ 全部正确落地
```

- `adjust_credits` RPC 语义**已符合 CR §5.1**：`amount = new − old` 写 `admin_adjustment` 流水（含 from/to/reason/actor），绝非裸 UPDATE。
- 全部 9 个账户（demo01–08 + admin）**均有** `credit_accounts` 行（无缺行）。

**根因判定（UX 层，非功能层）**：
1. 余额单元格是"**点击数字**进入编辑"——无任何可见编辑入口标识，操作不可发现（= 观感"没法改/没反应"）；
2. 保存**无成功 Toast**；失败信息只显示在**页面顶部 banner**（距操作点远，且是英文原始报错）；
3. Unlimited 是文字 ON/OFF 按钮，点击后无任何即时反馈；
4. 叠加风险：V1.2 部署时曾发生**浏览器强缓存旧 bundle** 事件——若 Owner 当时在旧 bundle 上操作，行为确实可能异常（旧 bundle + 新 API 的组合无保障）。

### 1.2 审计中发现的真缺陷（BUG-A；BUG-B 经实施验证证伪，保留记录）

| # | 缺陷 | 机制 | 修复方向 |
| --- | --- | --- | --- |
| BUG-A | **Unlimited 对无账户行用户 = 静默 no-op** | Worker PATCH `credit_accounts` 命中 0 行时 PostgREST 返回 200+空数组 → Worker 记审计"成功"但 DB 未变 | Worker 检查 representation 为空 → 返回 404 `credit_account_missing`（前端可提示） |
| ~~BUG-B~~ | ~~新建用户没有 credit_accounts 行~~ → **审计后证伪**：0010 §4 的 `handle_new_user` 触发器已在 `auth.users` INSERT 时自动建 `credit_accounts(balance 0)`，新用户不存在缺账户行问题。0017 冒烟 T4pre 已用真实触发器路径验证（3 个新建测试用户全部自动建户、balance=0）。当初"admin 缺账户行"是因该账户早于触发器上线（存量缺口），已用 service_role 手工补建 | 无需修复（保留记录为审计诚实性说明） |

### 1.3 排期 / 合集现状

- **Schedule**：0016 只有发布态（draft/published/archived），**无进度概念** → CR 三状态需新列（迁移 0017）。
- **Collection 封面**：Admin 现状 = 成员资产行内小按钮（设为封面/清除封面），无合集级封面管理入口、无可视化选图；无封面 = FolderOpen 图标（无文字说明）。封面只能取自本合集资产——DB 守卫 `COLLECTION_COVER_MISMATCH` 已在（CR §2.3 要求保持，零改动）。
- **空合集**：`published_collections` 视图 **inner-join 资产 → 0 资产合集不会出现在公域**（0012 Gate §7 既有决策"避免空壳暴露"）→ CR §2.7 前台半条天然满足；Admin 侧"暂无 Asset"提示照做。
- **下载成本显示**：ZIP 选中后显示 Cost（✅）、Package 面板显示（✅）；**单图按钮无费用标签**（待补，G6）。

---

## §2 裁决点

| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **G1** | Schedule 三状态实现 | 迁移 **0017**：`schedule_items` 加列 `progress text not null default 'not_started'`（CHECK 三值，**与发布态正交**）+ `published_schedule_items` 视图末列补 `progress`。公开页：🟢 已完成（删除线+灰）/ 🔵 进行中 / 🔴 未开始；Admin：每行三段式 segmented control 即时切换（成功后 reload 同步）。**筛选器 v1 不做**（页面简单，CR 允许可选）。审计：progress 变更记 `schedule.item_updated`（fields 含 progress，allowlist 零新增） |
| **G2** | Collection 封面 UX | Admin 选中合集的成员区**顶部加「封面管理」卡**：无封面 → 明确空态「尚未设置合集封面」+ [设置封面]；有封面 → 预览图 + [更换封面] [移除封面]。点设置/更换 → **可视化选图 Dialog**（本合集资产的图片缩略图网格，点选 → 设为封面；选图来源越界由 DB 守卫终审）。空合集 → Dialog 内提示「请先向此合集添加 Asset，再设置封面」。前台 Card 无封面 → 4:3 区内 FolderOpen + 「暂无封面」文字（**高度不变**）。**DB 零改动** |
| **G3** | Credits 根因修复 + 操作重构 | (a) 修 BUG-A/BUG-B（§1.2，零迁移）；(b) Users 页 Credits 单元格改**显式 [调整] 按钮** → Dialog：当前余额 + **[+10][+50][+100] 快捷（直接生效+Toast）** + Set Balance（**Reason 必填 + 确认对话**「从 X 改为 Y?」）+ 负调（−10/−50 折叠在 Dialog 内，不摆列表）+ Unlimited switch（Toast 反馈，不改 balance——既有 RPC 语义已保证）；(c) 成功/失败均 Toast + 列表即时刷新；(d) Set Balance 需确认、Delete User 保持二次确认（CR §10 口径） |
| **G4** | 批量调整积分的原子性 | **方案 A（推荐）：新增 RPC `admin_batch_adjust_credits(p_user_ids uuid[], p_delta numeric, p_reason text)`**——SECURITY DEFINER，函数内逐用户校验+adjust，任一失败 raise → 整体回滚 = **整批成功或整批失败**（真原子，CR §8.3 推荐语义）；Worker 新端点 `POST /api/admin/users/credits/batch`（admin only，逐 userId 合法性校验）；ledger 每用户一条 `admin_adjustment`（metadata.operation='batch'）；**audit 复用 credits.adjusted 零 allowlist 新增**。前端：用户列表复选框 + 「批量调整积分」条。**拒绝方案 B**（Worker 循环=非原子，伪装 atomic） |
| **G5** | Users 列表 Actions ⋯ 菜单 | 采纳：操作列收敛为 ⋯ dropdown（角色/禁用/删除/调整积分入口），移动端友好；顺带优化但不重构无关逻辑 |
| **G6** | 下载成本预显示 | 补齐单图下载按钮的费用标签（`N 积分`）；Unlimited 用户所有费用标签替换为 `♾ 无限`（徽标已有，逐处核对补齐） |

**非目标（CR §15 原样继承）**：充值/支付/优惠券/积分过期/商城/转赠/邀请奖励/复杂账单；不重构无关页面；不绕过 RLS/Worker/RPC。

## §3 数据库方案

- **0017（唯一迁移，幂等）**：`alter table schedule_items add column if not exists progress ...` + CHECK + `published_schedule_items` 视图重建（progress 末列，排序不变）+ 注记。**collections / credits / RLS / allowlist 零改动**。
- 隔离库冒烟：0017 全量应用 + progress 三值校验 + 视图暴露 + 发布态正交性。

## §4 实施顺序（批准后）

```
0017 + 冒烟 → G1 Schedule 双端 → G2 封面 UX → G3 两 BUG 修复 + Dialog 重构
→ G4 批量 RPC + Worker + 前端 → G5 ⋯ 菜单 → G6 成本标签
→ 回归（CR §17 矩阵逐项：含"改积分→刷新仍正确""改 Unlimited→刷新仍正确"）
→ commit+push → 生产部署（单独授权）
```

## §5 安全影响评估

- 普通用户权限面零变化（只读自己 Credits；不能调 adjust/batch——RPC 内 `service_role or is_admin` 守卫不变）
- 新 RPC 仅 service_role 可调（Worker Secret 持有）；Worker batch 端点经 `requireAdmin`
- 审计/ledger 全链保留：谁、改谁、from/to、reason、何时——batch 逐用户落 ledger + audit
