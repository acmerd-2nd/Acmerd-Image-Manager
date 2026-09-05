# PC-4（Credits 下载扣分接线）验证证据汇总

> 汇总时间：2026-09-06（GMT+8）　汇总人：接续 `PC4-收口_沙箱31of33与W0f收尾_20260905.md` 的 Agent
> 三态声明（逐句区分，不可混写）：
> - **已授权**：Owner 批准 Phase C 开工 + PC-4 沙箱验证（隔离 wrangler dev + 生产 Supabase/GitHub，e2e4 一次性实体，finally 清理）；并追加授权 ① 以「W7 200 = raw 可用」豁免 W0f、关闭 PC-4 沙箱 Gate；② 精确删除 1 个 GitHub 测试孤儿 blob。生产功能部署**未**授权。
> - **已执行**：420s 窗口沙箱重跑 + Step 4 独立残留复核（只读）+ 上述授权孤儿 blob 删除。
> - **已部署**：无 Worker 发布、无 Supabase 数据/结构改动、Supabase Storage 原件零改动；GitHub 生产镜像仓新增 1 次 **Owner 授权的清理 commit `f0e23399`**（仅删除测试孤儿 blob，非功能变更）。远端 Git 未 push。

---

## 1. 产品代码变更（本会话）

- **零产品代码改动。** 唯一相关的产品改动 `worker/index.ts:199` 的 `idempotencyKey ?? null`（`d6ad0fc`）系上一会话完成并已提交，本会话仅确认其存在。
- 本会话所有 commit 仅在本地 main；未触碰远端、未发布 Worker、未改任何生产数据面。

## 2. 沙箱全矩阵结果（本轮权威运行 = 31 PASS / 2 FAIL）

- 证据原文：`docs/v1.1/evidence-pc4-sandbox-final.md`（本轮，`e2e4mtolr7aw`，两图 `027c059d…` / `bac0e856…`）。
- 历史对照：`docs/v1.1/evidence-pc4-sandbox-rerun.md`（`aa22e71` 提交，同为 31/2）；`evidence-pc4-sandbox.md`（`d44282e` 首跑基线 23/7，修复前）。
- 全绿覆盖：W0–W0e2 前置；W1 401 / W2 未发布 404+不扣分 / W3 402 / W4 Set Balance=5 / W5 单图 302 扣 5→4 / W5d 幂等重放不重复扣 / **W7 ZIP 200 扣 4→3** / W6 同 key 异参 409 / W8 ZIP 402 / W9 Package 402 / W10 unlimited 302 不扣 / W11 admin_adjustment 流水 / **W12a github-delete 闭环 / W12b 清理零残留 assets=0 users=0**。
- 2 FAIL：**W0f（img1、img2）GitHub raw 传播等待** —— 见 §3 定性。

## 3. W0f 定性：环境出网非对称，非产品缺陷（关键证据链）

1. 上一版把 W0f 归因于「raw 传播 >150s」，并把 `waitGithubRaw` 提到 **420s**。本轮 420s 已跑满，img1/img2 **仍全程 404**（`last=404 after 421303ms / 422197ms`）→ **传播慢假设被证伪**。
2. 判别性证据：**W7 ZIP 200 PASS**。ZIP 端点由 **worker（workerd）服务端**对 raw 做 `preflightHead` + 流式下载成功（200）并正确扣分 4→3 → 证明 **raw 内容真实存在且从 worker 侧可达**。
3. 结论：W0f 是**沙箱脚本用本地 Node 进程轮询 `raw.githubusercontent.com` 被环境出网策略阻断**（本会话另有强制死代理 `http_proxy`），与 worker 出网是两条链路。**属环境限制，非产品 bug。**
4. 因此本轮 **31/2 与历史 31/2 等价**，且比历史多证一层：420s 都不通排除了「再等等就好」，把根因从「传播」修正为「本地 Node 出网受限」。
5. **Gate 定性留给 Owner**：W0f 两项是否以「W7 200 = raw 可用证明」作豁免并关闭沙箱 Gate，**须 Owner 裁决**；本 Agent 不擅自降标判 PASS。

## 4. 本会话新增环境坑与规避（非产品）

- 本机**全局 `npx`/npm 损坏**（`AppData\Roaming\npm\node_modules\npm\bin\npx-cli.js` 缺失）→ 提交的 `_pc4-runner.sh` 里 `npx wrangler dev` 直接 `MODULE_NOT_FOUND`、worker 起不来。
- 规避：**不经 npx**，改用项目本地二进制 `node node_modules/wrangler/wrangler-dist/cli.js dev --port 8787`（wrangler 4.128.0），其余逻辑（8787 + `NO_PROXY='*'` + noproxy 探活 + 单进程树 + 1500s 兜底）与提交版一致。临时 runner：`scripts/_pc4-runner.local.sh`（用后即删，不入 Git）。
- 首次 `bash scripts/_pc4-runner.sh`（走坏掉的 npx）在污染状态下产出一版自相矛盾的 30/3（`W12a github-delete FAIL`）并误写进 `evidence-pc4-sandbox-rerun.md`；已 `git checkout` 复原该文件到提交态，权威结果只落在新文件 `evidence-pc4-sandbox-final.md`。

## 5. Step 4 —— 生产零残留独立复核（只读）

- **Supabase DB：零 e2e4 残留** —— `assets?slug=like.e2e4*`=0；`assets?name=like.%PC-4 matrix%`=0；`/auth/v1/admin/users` 中 email `e2e4*` / `*@pc4.test`=0。
- **GitHub 镜像仓：1 个孤儿测试 blob** —— `assets/4a90c223-644c-4818-9971-b1ee69f1e418/en/02-100ed325.png`。
  - 溯源（commits?path）：`16:34:03 upload 01-0f58de5e.png` → `16:34:12 upload 02-100ed325.png` → `16:49:19 delete 01-0f58de5e.png`（img01 已删、img02 未删）。时间落在 §4 所述**被坏 npx 污染的首次运行**（`W12a` 中途失败）窗口内；权威运行自身的图（`e2e4mtolr7aw` 的 dir）已随 `W12a PASS` 清干净。
  - 影响面：无 DB 资产行引用 → `makeImageUrl`/可见性两门都取不到它 → **用户不可见、不可下载，零功能影响**，纯仓库面清洁度问题。
  - 处置（**已授权 + 已执行**）：Owner 明确授权精确删除该孤儿 blob。经 GitHub Contents API `DELETE` 单文件删除，cleanup commit `f0e23399`；复核该路径现 **404**，仓库仅剩 1 个资产目录 `5d5449a9-…-973b-5e1c37b3a431`（生产真图 `tu1.jpg`，未触碰），`assets/4a90c223` 随空自动消失 → **仓库零孤儿**。该授权仅覆盖此测试孤儿 blob；Supabase Storage 原件清理**从未授权、未执行**。

## 6. Step 5 —— 隔离库冒烟（环境限制，未伪造重跑）

- `scripts/v11-pc4-smoke.mjs` 依赖本地隔离 Postgres（`DATABASE_URL` @ 5432）；**本机 5432 无监听**（沙箱环境无本地 Postgres）。
- 沿用上一会话里程碑：commit `7e89ae7` 记录 **隔离库冒烟 13/13 PASS**（H2 幂等三态、unlimited 旁路、退款仅一次、grants 收敛）。**本会话不伪造重跑**，仅注明环境限制。

## 7. 冻结不变量复核（红线，全部保持）

- RLS 唯一真源；Service Role 仅在 Worker Secret；两级可见性 `Asset.published AND Language.published`；Credits H2 幂等 + C6 无负余额 + 一 debit 一 refund + unlimited 旁路；`makeImageUrl`/`imageSrcOf` 唯一 URL 出口；public bucket 保持 public；**Storage 原件 `01-15822bee.jpg` 零触碰**；`.dev.vars` 本机对齐生产仓未回退；凭据不入 chat/Git/文档/记忆。

## 8. Gate 结论

- **PC-4 沙箱 Gate：CLOSED（Owner 2026-09-06 裁决）。** 31/2 中差的 2 项 W0f 已定性为本地 Node raw 出网限制（非产品缺陷，W7 200 反证 raw 可用），Owner 批准以「W7 200 = raw 可用证明」豁免并关闭 Gate。GitHub 孤儿 blob 已按 Owner 授权精确删除（`f0e23399`）。产品代码面零缺陷残留。
- 本会话产物（本地 main）：`evidence-pc4-sandbox-final.md`（新，权威 31/2）+ 本汇总 `11-pc4-verification-evidence.md` + 看板/记忆更新。
- **生产部署仍未授权**（单独授权，绝不自动）。PC-4 收口 → 进入 PC-5。
