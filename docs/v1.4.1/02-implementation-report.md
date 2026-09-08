# V1.4.1 Credits Pricing Adjustment — Implementation Report（收口）

> **状态**: ✅ **IMPLEMENTED + DEPLOYED + 生产验证 23/23 PASS**（2026-09-08）
> **Gate**: `docs/v1.4.1/01-design-gate.md`（D1–D4 全批）
> **部署版本**: Worker ver `1d0c454b-b2ce-431c-90a5-842fdebb848c`（100% 流量）；0020 已生产应用
> **红线遵守**: 只调 Package 计价语义；Single/ZIP/Credits 基础模型零改动；零 scope 扩张

## 1. Implemented

Package Download 由固定一口价（15）改为**按图片数动态计价**：
`amount = published_ready_image_count(整个 Asset 跨全部已发布语言) × package_download_cost_per_image`

- 服务端唯一权威：客户端仅提交 `sourceId`；asset_id 取自已校验的 `download_sources` 行；计数与成本均服务端直查 DB。**客户端无法篡改 image count / cost / amount**（矩阵实测伪造字段无效）。
- `image_count < 1` → `404 not_available`，绝不 0 成本放行。
- H2 幂等保留：同 key 重放返回成功但 ledger 仅一条（amount 为五元组成员）。
- unlimited 旁路保留（RPC 内不扣不写流水；UI 显示 `N images · ♾`）。
- Package 与 `?lang=` 完全解耦（计数不接收语言参数）。

## 2. Files

| 文件 | 变更 |
| --- | --- |
| `supabase/migrations/0020_package_per_image_cost.sql` | 新增 KV 种子 `package_download_cost_per_image='0.5'`（幂等）；旧键保留（D1） |
| `worker/index.ts` | `SETTING_KEYS`/`NUMBER_KEYS` 换键；PATCH 数字校验放宽两位小数；Package 端点动态计价（asset_languages + images `Prefer: count=exact` 直查计数，`<1` → not_available；metadata 留痕 image_count/per_image_cost） |
| `src/features/settings/api.ts` / `src/features/admin/api.ts` | 字段改名 `package_download_cost_per_image`（默认 0.5） |
| `src/features/downloads/PackageDownloadPanel.tsx` | 新增 `imageCount` prop；动态价徽标 `{count} 张 · {n} 积分` / `{count} images · {n} credits`；无限 → `{count} 张 · ♾` |
| `src/routes/pages/AssetDetailPage.tsx` | 传入 `imageCount={asset.image_count}` |
| `src/routes/pages/admin/AdminDashboardPage.tsx` | label → `packagePerImageCost`；校验放宽 `/^\d+(\.\d{1,2})?$/`；input `step=0.01`；保存字段改名 |
| `src/i18n/zh.ts` / `en.ts` | `credits.packageCost` 双参格式 + 新增 `packageCostUnlimited`；`admin.platform.packagePerImageCost`；hint/invalidPrice 更新 |
| `src/types/database.ts` | `SiteSettingKey` 联合类型修正为 8 个真实 key（顺带修复陈旧债务） |
| `scripts/v141-package-pricing-verify.mjs` | 生产价格矩阵验证脚本（幂等建实体 + finally 清理 + 余额还原） |

## 3. Database

- **0020 已应用**（service_role REST upsert，http 201）：`package_download_cost_per_image = 0.5`。
- 旧键 `package_download_cost = 15` **保留未动**（D1 回滚兼容；新代码零读写）。
- **无 DDL/RLS/RPC 变更**。`schema_migrations` 0020 记账缺省（service_role 无 INSERT，DNS 恢复后自愈，同 0019 先例）。

## 4. 关键技术发现（矩阵验证拦截的 P0）

**`published_assets` 视图对 service_role 无 SELECT 授权**（0001 仅 grant anon/authenticated → svc 查询 42501 permission denied）。初版 Worker 实现查该视图会 **500 打挂全部 Package 下载**——被矩阵验证第一轮实证拦截。
**修复**: Worker 改走基础表直查计数（`asset_languages(status=published)` → `images(status=ready)` + `Prefer: count=exact`），口径与视图完全一致，零 grant 扩张（最小变更纪律）。

## 5. Tests / Evidence（生产实测，2026-09-08）

`node scripts/v141-package-pricing-verify.mjs` → **23/23 PASS**（日志 `docs/v1.4.1/_evidence-pricing-verify.log`）：

| 用例 | 结果 |
| --- | --- |
| 矩阵 7/9/20/30 图（单语言 EN） | 扣费 3.5 / 4.5 / 10 / 15 ✅（ledger amount 逐项核对 ✅） |
| **多语言 EN7+DE8+IT9 = 24 图** | **扣费 12 ✅**（证明跨语言计数 + 动态计价 + 服务端权威三合一） |
| 0 图资产（发 1 图后删图构造） | `404 not_available` + 零扣费 ✅ |
| 篡改（伪造 imageCount/cost/amount 字段） | 金额仍 = 3.5（服务端权威）✅ |
| 幂等重放（同 key × 2） | 双 200 + ledger 仅 1 条 ✅ |
| finally 清理 | e2e7 资产 0 残留 + 余额还原快照 ✅ |

- typecheck（前端+worker）0 error；build ✓（`index-D_e27djE.js` 上线核验一致）。
- 前置门禁实测：0003 `PUBLISH_BLOCKED` 守卫结构性禁止 0 图发布（T6 须构造）。

## 6. Security

- 计费三要素（计数/成本/金额）全部服务端权威；asset_id 源自已验证 source 行，客户端零篡改面（实测伪造字段无效）。
- numeric(12,2) 全链原生支持小数；admin PATCH + 前端输入双重校验（≤2 位小数，0–1000000）。
- `settings.updated` 审计照常落 audit_logs（含新键）。
- 测试扣账 ledger 行以 e2e7 sourceId 可追溯（append-only 设计内；余额已还原，与 PC-7 先例一致）。

## 7. Gate Status

| 项 | 状态 |
| --- | --- |
| Design Gate（D1–D4 + 附加矩阵要求） | ✅ APPROVED |
| 代码实施 + typecheck/build | ✅ |
| 0020 生产应用 | ✅（REST upsert） |
| Worker + 前端部署 | ✅ ver `1d0c454b` |
| 生产矩阵验证 | ✅ 23/23 PASS |
| commit / push | commit 本地完成；push 待 Owner 确认 |
| 遗留开口 | ① `published_assets` 视图 svc 无授权（已绕行，如后续需要可在 Owner SQL Editor `grant select … to service_role`）；② `schema_migrations` 0020 记账自愈待 DNS 恢复；③ 旧键 `package_download_cost` 保留（D1），可日后清理迁移删除 |
