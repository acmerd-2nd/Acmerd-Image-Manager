# V1.3 Change Proposal — 用户积分流水自助查看页

> **提出**: 2026-09-07 · **发起人**: Agent（总纲对比盘点时发现的可选增强，Owner 指示立项）
> **背景**: `credit_transactions` 本人只读 RLS（0010 `select own`）自 V1.1 起就绪，但用户端只有余额徽标 + 不足提示，**没有自助查看扣分记录的入口**。总纲1.1 建 ledger 的动机是 Admin 排查（"这个用户为什么只剩 7 分"），未要求用户自助——本提案把它作为低风险纯前端增强立项。
> **版本**: 建议 **V1.3 单项**（V1.2 已全链 CLOSED，不回填）。

---

## §1 提案内容（一句话）

登录用户可在一个新页面查看自己的积分流水（类型 / ±金额 / 余额快照 / 时间），按时间倒序，空态友好；**零 schema、零 RLS、零 Worker 变更**（纯前端读 RLS 放行数据）。

## §2 事实边界（已核验）

- `credit_transactions` 现有 6 种类型：`image_download / zip_download / package_download / admin_adjustment / download_refund / seed_initial`（0010 CHECK）
- 字段：`type, amount(±), balance_after, reference_type, reference_id, metadata, created_at`；只追加（无 UPDATE/DELETE 授权）
- RLS：本人可读（`user_id = auth.uid()`），客户端直读合法、无需新端点
- 现有 UI：`CreditsBadge`（右上角余额）已存在，可作入口挂点

## §3 改动面

| 层 | 改动 |
| --- | --- |
| DB | **零** |
| Worker | **零** |
| 前端 | 新页 `CreditsPage`（或 Profile 内嵌区，见 C1）+ `src/features/credits/api.ts`（listOwnTransactions）+ `CreditsBadge` 可点击 + i18n zh/en（`credits.*` 若干 key） |

## §4 裁决点

| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **C1** | 入口形态 | **Profile 页内嵌「积分记录」区块**（登录用户必经之地，不加导航项、不加路由——最小改动）；备选：独立 `/credits` 页 + 余额徽标点击跳转 |
| **C2** | 分页策略 | **limit 50 + 「加载更多」**（range 查询递增）；ledger 场景几乎不会一次看很久，完整分页组件是过度设计 |
| **C3** | reference 展示 | **v1 只显示类型 + 时间 + ±金额 + 余额快照**；不 join 资产名（`reference_id` 是 asset/image id，join 需额外查询且已删资产会空挂）。metadata 里已有的明细（如 ZIP 张数）直接展示 |
| **C4** | CSV 导出 | **v1 不做**（避免前端拼 CSV 的注入面；真需要走 Change Proposal） |
| **C5** | 金额语义 | debit 显示负号（−1）、refund/adjustment 按正负原样显示；`balance_after` 作"余额快照"列——与 Ledger 既有语义一致，不新造口径 |

## §5 非目标（Out of Scope）

- Admin 侧任何改动（Admin 排查已可经 service_role 直查）
- 用户间转账 / 充值 / 任何写路径
- 导出、搜索、按类型筛选（可作未来增强）

## §6 安全边界

- 数据面 = 既有 RLS `select own`，天然隔离他人流水
- 无新端点 → 无新认证面；无用户输入进入查询（无注入面）
- i18n 全 key 化（zh/en 同构），沿用 PC-1 惯例

## §7 验收口径（批准后按此收口）

1. User 登录 → Profile 见「积分记录」：显示自己的流水（倒序、±金额、余额快照、类型中文标签）；**看不到他人任何行**
2. 下载一次（扣分）→ 回流刷新可见新行（CreditsBadge 余额同步）
3. Admin 调分 / refund → 对应类型标签正确
4. 空态文案（新用户 0 流水）；「加载更多」到尽头即隐藏
5. typecheck/build 绿；沙箱走查（真浏览器，含无痕=Guest 重定向 Profile 登录）
6. 零残留（无 e2e 数据——本项纯读，不造数）

## §8 实施顺序（批准后）

前端 api → CreditsPage 区块（含 C1 形态）→ Badge 入口 → i18n → typecheck/build → 沙箱走查 → commit+push → 生产部署（单独授权）。预计改动量 ≈ 1 个新组件 + 1 个 api 文件 + 若干 i18n key，**半天内收口**。

---

**等待 Owner 逐项裁决（C1–C5，可"全按建议"）——未裁决前不动代码。**
