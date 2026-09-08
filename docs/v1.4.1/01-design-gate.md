# V1.4.1 Credits Pricing Adjustment — Design Gate（已批）

> **状态**: ✅ **Gate APPROVED**（Owner 华子哥 2026-09-08，D1–D4 全批 + 附加矩阵测试要求）
> **范围红线**: 只调 Package 计价语义；不动 Single/ZIP 语义、不动 Credits 基础模型（0010）、不扩 scope。

## 1. 背景与根因

**问题**: Package Download 为固定一口价 `package_download_cost = 15`（0011 种子），与资源图片数量完全脱钩——主图 7–9 张与 A+ 20–30 张的资源包同价，价格严重失衡。

**根因**: 计价模型缺陷（固定值），非安全缺陷。价格来源已服务端化：Worker `POST /api/downloads/package` 仅收 `{ sourceId }`，金额读 `site_settings` 固定键。

**权威计数源（零新建）**: `published_assets.image_count` 视图（0001 定义、0014 重建）= 整个 Asset 跨所有已发布语言的 `images.status='ready'` 图数，与前台详情页展示的 `asset.image_count` 同源 → **显示数 == 收费数天然一致**。

## 2. Owner 裁决（2026-09-08）

| # | 裁决 | 内容 |
| --- | --- | --- |
| D1 | ✅ APPROVED | 保留旧键 `package_download_cost` 作回滚兼容；V1.4.1+ 代码不得读写 |
| D2 | ✅ APPROVED | 用户侧价格格式：`N images · X credits` / `N 张 · X 积分`；无限用户 `N images · ♾` |
| D3 | ✅ APPROVED | 初值：Single=1 / ZIP per-image=1 / **Package per-image=0.5** |
| D4 | ✅ APPROVED | 计数口径 = 整个 Asset 跨所有已发布语言的 published+ready 图数，与 `?lang=` 无关 |

**实施约束（Owner 明令）**:
- 服务端为 image_count / 每图成本 / 最终金额的唯一权威；客户端不得提交或覆盖。
- `image_count < 1` 必须返回 `not_available`，绝不免费放行。
- 保留 H2 幂等语义：同 key + 不同金额 → `IDEMPOTENCY_CONFLICT`。
- 保留 unlimited 旁路、Package 语言无关性、单次授权跳转不追踪外链结果。

**附加验证要求（Owner）**: 真实价格矩阵——单语言 7→3.5 / 9→4.5 / 20→10 / 30→15；多语言 EN7+DE8+IT9=24→12。一次证明动态计价 + 跨语言计数 + 服务端权威计算三件事。

## 3. 方案摘要

| 层 | 变更 |
| --- | --- |
| DB | 仅 0020 KV 种子（`package_download_cost_per_image='0.5'`）；无 DDL/RLS/RPC 变更 |
| Worker | SETTING_KEYS/NUMBER_KEYS 换键；PATCH 数字校验放宽两位小数；Package 端点按 `published_assets.image_count × per_image` 计价（`<1` → not_available），metadata 留痕 |
| 前端 | 设置类型字段改名；PackageDownloadPanel 新增 `imageCount` prop + 动态价徽标；Admin 输入改 label/小数校验/step=0.01 |
| i18n | `credits.packageCost` 改双参格式 + 新增 `packageCostUnlimited`；`admin.platform.packagePerImageCost`；hint/invalidPrice 文案更新 |

**安全不变量**: 价格/计数全部服务端权威（asset_id 源自已验证的 download_sources 行）；H2 幂等（金额为五元组成员，重试间价格/计数变化 → 409 正确行为）；numeric(12,2) 全链原生支持 0.5；unlimited 旁路不变。

## 4. 验证计划

见 `02-implementation-report.md`（实施后补）：typecheck/build 绿 → 0020 生产应用 → 部署 → `scripts/v141-package-pricing-verify.mjs` 价格矩阵（e2e7 前缀测试实体 + finally 全量清理 + 余额还原）。
