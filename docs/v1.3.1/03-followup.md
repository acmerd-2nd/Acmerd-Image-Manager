# V1.3.1 跟进修复 — Owner 走查反馈（F1/F2/F3）

> 日期：2026-09-08 · 触发：Owner 生产走查反馈（用户管理三项问题）· 裁决：AskUserQuestion 双项 Owner 选定（列表列直接可切 / 独立表+审计）

## 根因诊断（生产复现实证）

### #2 「无法修改积分，调整按钮灰色」= credit_accounts RLS 读面缺陷（真根因）
- 0012 §3 的策略 `credit_accounts select own` 只写了 `user_id = auth.uid()`，**漏了 admin 分支**（同节 `credit_transactions` 有 own-or-admin，`credit_accounts` 没有）。
- 实测：admin JWT 直读 `credit_accounts` 仅返回自己 1 行（全库 9 行）→ Users 页 creditsMap 缺他人行 → 积分列 `—`、「调整积分」`disabled={!credits}` 灰色 → Dialog 打不开。
- 全库对账：9 profiles 全部有 credit_accounts 行（无缺行问题；demo08 余额 100 为历史验证值）。

### #1 「无法开关普通用户无限积分」= 被 #2 连带挡死（开关链路本身健康）
- 生产实测（真实 admin 会话）：对 demo01 `POST /api/admin/users/:id/credits {unlimited:true}` → 200 + DB true；关回 → 200 + DB false。Worker/RPC/审计全通。
- Owner 感知「无法开关」是因 Dialog 打不开（同 #2 根因）。

### #3 管理员备注 = 新功能 → Gate 裁决
- Owner 选项：**独立表 + 审计（推荐，已选定）**；否决 profiles 加列（用户可经 own-row RLS 读到）。

## 方案（Owner 已批）

| # | 内容 |
| --- | --- |
| F1 | 0018：`credit_accounts` SELECT 策略 → `user_id = auth.uid() or is_admin()`（只读放宽；写路径零变化——无写策略 + grants 仅 service_role，Worker 独占不变） |
| F2 | 苹果式 Switch 组件（`src/components/ui/switch.tsx`，自维护零依赖）：Users 列表 Unlimited 列**直接可切**（+Toast）+ CreditsAdjustDialog 内同步换 Switch |
| F3 | 0018：新表 `user_admin_notes`（user_id PK→auth.users cascade / notes / updated_at / updated_by）+ RLS 仅 `is_admin()`（ALL 策略）+ 专用审计触发器 `users.notes_updated`（write_audit 用 new.id，本表主键是 user_id 故自建函数）+ allowlist 43→44（严格超集 + 防窄化守卫）+ grants（anon 零接触） |

## 冒烟与部署

- 冒烟：`scripts/v1311-smoke.mjs`（隔离库 0001→0018，T1–T6：策略/表/RLS/allowlist 44/触发器建户不回归/admin 读全量+普通用户仅自己/备注 upsert+审计+普通用户与 anon 拒绝）。
- 部署：0018 生产应用 → build+deploy（bundle 含 F2/F3）→ 生产验证（admin 读 9 行 / 备注回环 / 开关回环）。
- ⚠️ 环境注记：2026-09-08 晚本机到 `db.*.supabase.co`（纯 IPv6 主机，本机 IPv6 TCP 出网超时）与全部 pooler region（XX000 tenant not found）均不可达；REST/GoTrue（HTTPS）正常。冒烟与迁移待 egress 恢复后执行，恢复前**不部署**。

## 状态：**CLOSED**（2026-09-08）

- [x] 根因诊断（生产复现 + 复原，零残留）
- [x] 0018 迁移落稿（幂等）
- [x] F2/F3 前端实现 + typecheck/build 绿
- [x] 0018 隔离冒烟 **13/13**（`scripts/v1311-smoke.mjs` T1–T6；曾修两处冒烟桩：user_roles upsert、审计断言须 commit 事务）
- [x] 0018 生产应用（db-apply OK，迁移 0001–0018）
- [x] 部署 ver **`ad5dfa69`**（bundle `index-CWLNOoWe.js`，AdminUsersPage chunk `BzYAzg3b`）
- [x] 生产验证：
  - admin JWT 读 credit_accounts = **9 行**（修复前 1 行）
  - Unlimited 开关回环（demo01 on=200/off=200，复原）
  - 备注写路径回滚实测：admin 事务内插入 + 审计 `users.notes_updated`(INSERT) 正确，ROLLBACK 零残留
  - 真实 UI 走查（浏览器，Owner 会话）：9 用户积分列全显示（demo08=100）、每行苹果 Switch、demo01 开→Toast「无限积分已开启」→关→false、⋯菜单=调整积分/备注/设为管理员/禁用、**「调整积分」不再置灰**；首页合集卡显示「暂无封面」新文案
- push：`4ec91d7..73e5aab`（含 b963de5 实装 + 73e5aab 冒烟修正）
