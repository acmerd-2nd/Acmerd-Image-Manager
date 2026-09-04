# V1.1 Phase B — PB-1 证据/收口报告

- **日期**: 2026-09-04
- **依据**: Phase B Design Gate（`04-phase-b-design-gate.md`，APPROVED WITH REQUIRED ADJUSTMENTS，Owner 2026-09-04 裁决）
- **范围**: **仅 PB-1**（Gate §9 实施清单）；完成后 STOP，不自动进入 Stage 1
- **纪律**: 生产库零触碰；生产 GitHub 仓库零写入；无部署执行

---

## 1. Implemented

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | `0014_phase_b_github.sql` — github_write_leases + claim/release RPC（SECURITY DEFINER，仅 service_role）+ images.status **四态**（uploading/ready/failed/deleting，Owner 必改）+ images.source_sha + 可见性收敛（RLS select 策略与 published_assets 视图只出 ready）+ 审计 allowlist 34→38 + **0013 防窄化守卫** | ✅ |
| 2 | `worker/github.ts` — GitHub Contents API 客户端：git blob sha 本地计算、GET meta / PUT / DELETE、重试矩阵（409/422 重取 sha 重试 1 次；限流立即失败；5xx/网络退避 ≤3）、子请求预算 ≤8、lease 抢占/释放封装、raw URL 构建 | ✅ |
| 3 | `POST /api/admin/images/github-upload` — requireAdmin → MIME/15MB 校验 → 租约 → INSERT(uploading, source_sha=本地预期 sha) → PUT → **response.content.sha === source_sha 校验**（Owner 附加要求）→ ready；失败 → failed + `github.upload.failed` 审计；崩溃窗口 → sweeper | ✅ |
| 4 | `POST /api/admin/images/github-delete` — **四态删除闭环（Owner 必改）**: ready → deleting（公开即刻不可见）→ GitHub DELETE → 成功/404 → 物理删 DB 行；失败 → 保留 deleting + `github.delete.retry` 审计 → sweeper 重试。**远端删除成功前绝不物理删 DB 行** | ✅ |
| 5 | 下载 provider-aware — 单图 302（github → raw URL）+ ZIP 预检/流式按 provider 分流（混 provider 支持）+ 全部查询加 `status='ready'` 过滤；**Credits 语义零变更**（Rev B D8 冻结不变量） | ✅ |
| 6 | scheduled sweeper — cron 每 10 分钟（wrangler `[triggers]`），单轮 ≤10 行：uploading→GET sha 对账收敛 ready/failed；failed+远端存在→补偿删除（`github.orphan.purged`）；deleting→重试远端删除后删行 | ✅ |
| 7 | 前端接线 — Admin 上传改走 Worker（`src/features/assets/github.ts`，浏览器仅持自身 JWT）；AdminAssetEditorPage/AdminAssetsPage 删除按 provider 分流（github 行**级联删除前**先走 Worker 闭环）；Lightbox/AssetDetailPage/封面 URL 全部切 `toPublicUrl(image)`/`imageSrcOf()`/`makeImageUrl`（唯一出口） | ✅ |
| 8 | `scripts/v11-phase-b-smoke.mjs` — 0014 隔离库冒烟 | ✅ 19 PASS / 0 FAIL |

## 2. 路径规范（Owner 必改落位）

**冻结**: `assets/{asset-uuid}/{langCode}/{filename}`（例 `assets/7d4c.../en/01-product.webp`）。Worker 上传端点按此拼路径；Gate 文档 §8 冲突措辞已修正；不使用 slug；不建独立 images branch。

## 3. Files

```
supabase/migrations/0014_phase_b_github.sql        (new)
supabase/migrations/0013_audit_allowlist_v11.sql   (modified: +防窄化守卫)
worker/github.ts                                   (new)
worker/index.ts                                    (modified: Env/上传/删除/下载/sweeper)
wrangler.toml                                      (modified: GITHUB_IMAGES_* vars + cron)
src/features/assets/github.ts                      (new)
src/features/assets/api.ts                         (modified: imageSrcOf/toPublicUrl provider-aware)
src/types/database.ts                              (modified: ImageRow.storage_path → null 联合真值)
src/components/Lightbox.tsx                        (modified: toPublicUrl(image))
src/routes/pages/AssetDetailPage.tsx               (modified: imageSrcOf)
src/routes/pages/admin/AdminAssetEditorPage.tsx    (modified: Worker 上传/删除分流)
src/routes/pages/admin/AdminAssetsPage.tsx         (modified: 删除分流)
scripts/v11-phase-b-smoke.mjs                      (new)
scripts/v11-phase-a-smoke.mjs                      (modified: MIG_V11 范围钉回 0009–0013)
docs/v1.1/04-phase-b-design-gate.md                (modified: 裁决并入)
docs/v1.1/05-phase-b-pb1-report.md                 (new)
```

## 4. Tests（隔离库，一次性库用后 DROP）

**Phase B 冒烟：19 PASS / 0 FAIL**
- C2 NO-DRIFT：全 ready 存量数据下 Guest 视角 0009–0014 前后逐字节一致
- S1–S7：status 默认 ready、CHECK 拒非法、非 ready 行 RLS 不可见、视图只计 ready、Worker 下载同款过滤
- L1–L7：租约抢占/互斥（显式 false）/无重入语义/非持有者释放无副作用/过期恢复/仅持有者释放/anon 拒执行
- A1–A2：github.* 动作可写（38 项）、越界仍拒
- RP/RP2：0009–0014 全量重放幂等、settings 种子不覆盖

**回归**：Phase A 冒烟复跑 **48 PASS / 0 FAIL**（0013 守卫无回归）；`npm run typecheck`（app+worker）通过。

**冒烟发现并修正**：
1. 重放链幂等缺陷——0013 窄化重建会撞 0014 引入的 github.* 行 → 0013/0014 均加"存在越界行则跳过重建"防窄化守卫。
2. claim 0 行返回 null → 改 CTE coalesce 显式 false（PostgREST JSON 恒布尔）。

## 5. Security

- GITHUB_TOKEN 仅 Worker Secret（wrangler secret put；wrangler.toml 无凭据）；浏览器只持自身 JWT。
- claim/release RPC 与 github_write_leases 仅 service_role（L7 证明 anon 拒执行）。
- 非 ready 行：anon/authenticated RLS 不可见（S4）、视图不计（S6）、Worker 下载/ZIP 查询过滤（S7）。
- 上传成功判定 = 2xx 且 sha 一致；失败行保留审计，公开不可见；无"假设成功"路径。

## 6. Evidence

- 冒烟可重放：`node scripts/v11-phase-b-smoke.mjs`（19/19）、`node scripts/v11-phase-a-smoke.mjs`（48/48）。
- typecheck 双 tsconfig 通过。
- 隔离库运行后自动 DROP，无残留。

## 7. Gate Status 与待 Owner 项

| 项 | 状态 |
| --- | --- |
| PB-1 代码 + 0014 + 冒烟 | 🟢 完成 |
| **dry-run direct 矩阵**（GitHub 层：Upload/sha 校验/重放/覆盖/冲突恢复/DELETE 幂等/raw） | ✅ **14 PASS / 0 FAIL**（沙箱 `image-dryrun-sandbox`，证据 → `07-dryrun-evidence.md`） |
| **dry-run e2e 全链路**（Worker + Lease + 四态闭环 + ZIP） | 🟡 19/19（E3–E10 结构性 SKIP：等 0009–0014 应用目标库后重跑，脚本就绪） |
| Stage 1（生产 1 张图迁移） | 🚫 PB-1 验收 + 迁移应用授权 + 单独启动授权 |
| Stage 2 | 🚫 更后置授权 |

**PB-1 到此停止，等待 Owner 检查。不自动进入 Stage 1。**
