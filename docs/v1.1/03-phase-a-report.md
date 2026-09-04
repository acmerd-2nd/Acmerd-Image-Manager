# V1.1 Phase A 结束报告

- **日期**: 2026-09-04
- **依据**: Design Gate Rev B（`01-design-gate.md`，APPROVED WITH REQUIRED ADJUSTMENTS）+ Owner 开工指令（2026-09-04）
- **Phase A Scope（Owner 钉死）**: 仅 0009–0013 + 基础数据访问层最小变更 + i18n skeleton
- **明确未做（Owner 排除项）**: GitHub 图片迁移、GitHub Admin 上传、Credits 下载扣分接线、注册 Worker、Collection UI、Schedule UI、用户 UI

---

## 1. Implemented

| # | 项                                                                                                                                                                                                                                                                                                   | 状态                 |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1 | `0009_v11_foundation.sql` — collections 表 / assets.collection_id（可空 FK）/ images provider+source_path（storage_path 解除 NOT NULL，CHECK 互斥）/ profiles.account_origin / **H1 双触发器**（guard_collection_cover、guard_asset_collection_move）                                                                  | ✅                  |
| 2 | `0010_credits.sql` — credit_accounts（balance CHECK>=0）/ credit_transactions（user_id **ON DELETE SET NULL** + 退款部分唯一索引 + idempotency_key UNIQUE）/ handle_new_user 扩展建账户 / **deduct_credits**（单语句原子 + H2 五元组幂等）/ adjust_credits / refund_credits（一 debit 一 refund）/ grants 收敛（execute 仅 service_role） | ✅                  |
| 3 | `0011_settings.sql` — site_settings + 5 key 幂等种子（on conflict do nothing）+ anon/authenticated 只读 grants + RLS                                                                                                                                                                                        | ✅                  |
| 4 | `0012_collections_rls.sql` — collections RLS / published_collections 视图（双层 published）/ 审计触发器（collection.created/updated/deleted/published/archived）/ grants REVOKE                                                                                                                                  | ✅                  |
| 5 | `0013_audit_allowlist_v11.sql` — allowlist 24→34 幂等超集 DO 块（0007 范式）                                                                                                                                                                                                                                 | ✅                  |
| 6 | 隔离库冒烟 `scripts/v11-phase-a-smoke.mjs` — 一次性库 0001→0008 + seed 快照 → 0009–0013 → NO-DRIFT + 全量负/正样本                                                                                                                                                                                                   | ✅ 48 PASS / 0 FAIL |
| 7 | 数据访问层最小变更 — `src/types/database.ts`（ImageSourceRow/CollectionRow/CreditAccountRow/CreditTransactionRow/SiteSettingRow/AccountOrigin）+ `src/lib/image-source.ts`（makeImageUrl 双 provider，source_url 不落库，CDN 切换口预留）                                                                                   | ✅                  |
| 8 | i18n skeleton — `src/i18n/{zh,en,index}.ts`（默认 zh-CN、类型同构强制、uiLocale ≠ assetLanguage 冻结规则、localStorage 持久化）                                                                                                                                                                                         | ✅                  |

## 2. Files

```
supabase/migrations/0009_v11_foundation.sql   (new)
supabase/migrations/0010_credits.sql          (new)
supabase/migrations/0011_settings.sql         (new)
supabase/migrations/0012_collections_rls.sql  (new)
supabase/migrations/0013_audit_allowlist_v11.sql (new)
scripts/v11-phase-a-smoke.mjs                 (new)
src/types/database.ts                         (modified: +7 类型, ImageRow +provider/source_path)
src/lib/image-source.ts                       (new)
src/i18n/zh.ts, en.ts, index.ts               (new)
docs/v1.1/01-design-gate.md, 02-owner-ruling-2026-09-04.md, 03-phase-a-report.md (new)
```

零改动：`worker/`、任何 UI 组件、`dist/`、0001–0008。

## 3. Database

- **生产库零触碰**。0009–0013 **未应用到任何共享环境**，仅在一次性隔离库（用后 DROP）中验证。
- ImageRow 类型保持 V1.0 UI 契约（storage_path 非空语义注释说明）；provider 感知切换归 Phase C。

## 4. Tests（隔离库冒烟，最终 48 PASS / 0 FAIL）

关键用例组：

- **C2 NO-DRIFT**: Guest 视角公开数据集合 0009–0013 前后 4 组快照逐字节一致 ✅
- **H1**: cover 同 Collection 校验（正/负样本）、被 cover 引用 Asset 禁止移出、拒绝后无部分生效 ✅
- **H2 幂等三态**: 同 key 同参 → 原结果不重复扣；同 key 异参/异用户 → IDEMPOTENCY_CONFLICT ✅
- **C6 并发**: 双连接并发扣分（余额 1）→ 恰一成功一拒绝、无负余额 ✅
- **退款**: refund 幂等（重复请求仅 1 行 refund）、非下载 debit refund → DEBIT_NOT_FOUND ✅
- **权限矩阵**: user 对 credit_accounts/credit_transactions/site_settings/deduct_credits 全部 denied；RLS 自读/跨读隔离 ✅
- **RP 重放幂等**: 0009–0013 全量重放行数不变；settings 种子重放不覆盖 ✅
- AL1 allowlist 恰 34 项、D3 provider 互斥 CHECK、D10 account_origin CHECK ✅

**冒烟过程中的两处修正（证据）**:

1. D3a：0009 需 `alter column storage_path drop not null`（0001 NOT NULL 与 CHECK 互斥冲突）——已修，D3a 转绿。
2. CR12b：测试断言算术错误（预期 +115，正确值 = 120 − 4 = **+116**）；RPC `amount = v_new − v_old` 逻辑正确——修断言，非修实现。

**环境插曲**: 本机网络一度无法解析/路由 Supabase DB（直连域名仅 AAAA、本机无 IPv6 路由窗口期）。脚本内置 Pooler 回退候选；本次恢复后直连成功。未影响生产库。

## 5. Security

- deduct/adjust/refund 均 SECURITY DEFINER + execute 仅授 service_role + 函数内身份双保险。
- credit_accounts/credit_transactions 对 authenticated 仅 SELECT（RLS user_id = auth.uid()）；写路径全在 RPC。
- site_settings anon/authenticated 只读；写仅 service role。
- collections 对 user 读写全拒（RLS）；Admin 经 service role / admin 判定路径。
- 无凭据落库/落 Git：冒烟脚本仅从 `.env` 读 DATABASE_URL（不回显）。

## 6. Evidence

- 冒烟输出全文：48 PASS / 0 FAIL（本报告 §4；脚本可重放：`node scripts/v11-phase-a-smoke.mjs`，一次性库自动 DROP）。
- `npm run typecheck`（app + worker 双 tsconfig）通过。
- 隔离库每次运行后 `drop database ... with (force)`，无残留。

## 7. Gate Status

| 项                  | 状态                                                            |
| ------------------ | ------------------------------------------------------------- |
| Phase A 实施         | 🟢 完成（隔离库验证）                                                  |
| 0009–0013 应用到生产    | 🚫 **未执行**，需 Owner 单独授权                                       |
| Phase B（GitHub 写入） | ⏸ 停在 Gate；开工前须先提交 **H3 跨 Worker 实例并发控制/冲突处理策略说明**（Owner 附加要求） |
| 图片两阶段迁移 Stage 2    | 🚫 需届时单独授权                                                    |

**Phase A 到此停止，等待 Owner 验收。不自动进入 Phase B。**
