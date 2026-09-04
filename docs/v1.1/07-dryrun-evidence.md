# V1.1 PB-1 Dry-Run 全矩阵证据报告

- **时间**: 2026-09-04 22:19–22:37 (GMT+8)
- **演练仓库**: `acmerd-2nd/image-dryrun-sandbox`（private，按 Gate 04 §10 Q5 裁决创建；验收后可删除）
- **执行环境**: direct = 本机 node 直连 GitHub API；e2e = 本机 `wrangler dev`（localhost:8787，**未部署**）+ `.dev.vars`（gitignored）
- **脚本**: `scripts/v11-phase-b-dryrun.mjs`（direct + `--e2e` 双模式，双重确认守卫）
- **生产影响**: 生产库零写入业务数据（e2e 布景 draft Asset 自动建立/清理）；生产 GitHub 仓库零触碰；零部署

## 1. 仓库甄别（写入前的安全前置）

| 仓库 | 判定 | 动作 |
| --- | --- | --- |
| `acmerd-2nd/-Photo-Acmerd-Image-Manager`（今日 07:41 新建，仅 README，描述"用于存image的图片"） | **生产 Image Repository 候选** | ❌ 不碰（Q5：绝不拿生产仓库当实验场） |
| `acmerd-2nd/Acmeimages` + `-2…-10`（存量图片，96MB） | 存量图片仓库 | ❌ 不碰 |
| `acmerd-2nd/image-dryrun-sandbox`（本轮新建 private） | Q5 演练仓库 | ✅ 全矩阵在此执行 |

Token 权限：`repo` scope（GitHub 官方 classic scope，含 private 仓库 Contents 读写）。

## 2. direct 矩阵结果 —— 14 PASS / 0 FAIL

| # | 用例 | 结果 | 备注 |
| --- | --- | --- | --- |
| M0 | 仓库可达 + token 有效 | ✅ | |
| M1 | 上传创建：response.content.sha === 本地 git blob sha | ✅ | Owner 附加要求逐字验证 |
| M2 | GET 元数据 sha 一致 | ✅ | |
| M3 | 同内容重放（幂等） | ✅ | |
| M4/M5 | 覆盖更新 + 复核新 sha | ✅ | |
| M6–M8 | raw HEAD/Content-Length/字节 sha256 | ✅ | private 仓库需带 token；见 §4 发现 |
| M9–M11 | DELETE + 幂等重放 + GET 404 | ✅ | |
| M12a | 已存在路径 + 过期 sha PUT → **409** | ✅ | 实测 409（非 422）；Worker 重试矩阵同时覆盖 409/422，**实现正确**，初版断言写窄已修 |
| M12b | 重试封装（重取 sha）恢复 | ✅ | |

## 3. e2e 全链路结果 —— 19 PASS / 0 FAIL（含 1 项结构性 SKIP）

| # | 用例 | 结果 |
| --- | --- | --- |
| E0 | `/api/health` 存活（本地 Worker） | ✅ |
| E1 | admin 登录（Supabase password grant） | ✅ |
| E2 | draft 测试 Asset/语言建立 | ✅ |
| E3–E10 | 上传全链路/路径冻结/raw/行状态/可见性守卫/四态删除闭环 | 🟡 **结构性 SKIP** |
| E11 | 测试 Asset 自动清理（含跳过路径） | ✅ |

**E3–E10 结构性阻塞原因（非缺陷）**：目标库（生产 Supabase）尚未应用 0009–0014 → `claim_github_lease` RPC 不存在 → 上传端点返回 `503 db_not_provisioned`。e2e 全链路在迁移应用后重跑同一命令即可。

**附带修复**：上传/删除端点原在此场景返回裸 500，已改为明确 `503 db_not_provisioned`（`worker/index.ts`，typecheck ✅）——部署后若库未迁移，Admin 会看到清晰错误而非 500。

## 4. 发现（需 Owner 知悉）

1. **raw 可达性依赖仓库 public 属性**：`raw.githubusercontent.com` 对 private 仓库匿名访问 404。生产候选仓库 `-Photo-Acmerd-Image-Manager` 为 **public** ✅，Worker 302 匿名下载语义成立。**请勿在生产 Image Repository 上切换 private**。
2. **GitHub 过期 sha 冲突实测返回 409**（非文档常见示例的 422）：Worker 重试矩阵 `409 || 422` 双覆盖的设计被实测证实必要。
3. e2e 全链路、ZIP 实测（需 publish 布景）两项推迟至 **0009–0014 应用生产之后**——该授权同时解锁 Stage 1。

## 5. Gate 状态

- direct 矩阵（GitHub 层）: ✅ **全部通过**
- e2e 全链路: 🟡 等待 0009–0014 应用目标库（Owner 授权）后重跑
- Stage 1: 🚫 仍需 Owner 单独授权；脚本与计划报告（`06-stage1-migration-report.md`）就绪
- 演练仓库 `image-dryrun-sandbox`: 验收后可删除（或保留复用）
