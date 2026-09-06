# PC-7 集成回归报告（V1.1 Phase C 收官）

> 执行时间：2026-09-06　执行人：接续 Agent（矩阵经 Owner 2026-09-06 批准）
> 三态声明：**已授权**＝Owner 批准本回归矩阵并批准执行；**已执行**＝下述沙箱/走查/复核；**已部署**＝无（远端未 push、生产 Worker 未发布、Supabase 数据面仅 e2e 一次性实体且已清零 + Owner 授权的 seed 8 用户 + settings 零改动）。

---

## 1. 回归矩阵与结果总览

| # | 矩阵项 | 结果 |
| --- | --- | --- |
| 1 | 隔离库全量复跑（Phase A 48 项 + PC-2 16 项 + PC-4 冒烟 13 项） | ⚠️ **环境受限未复跑**（见 §4），沿用历史证据 |
| 2 | 沙箱 E2E：PC-4 全矩阵 31 项复跑 | ✅ **31 PASS / 2 FAIL**（与已豁免基线逐项一致，见 §2） |
| 2b | 沙箱 E2E：PC-5 注册链路 8 项 | ✅ **8 PASS / 0 FAIL**（见 §2） |
| 3 | 前端 zh 模式全页面走查（12 路由） | ✅ **12/12 全绿**（见 §3） |
| 4 | 红线复核（静态 grep） | ✅ 全干净（见 §5） |
| — | 沙箱后零残留独立复核 | ✅ **CLEAN**（见 §6） |

## 2. 沙箱 E2E（本地 wrangler dev 单进程树 + 生产 Supabase/GitHub，零部署）

### 2.1 PC-4 全矩阵复跑 = 31 PASS / 2 FAIL（证据 `evidence-pc7-pc4-matrix.md`）
- 全绿覆盖：W0–W0e2 前置；W1 401 / W2 未发布 404+不扣分 / W3 402 / W4 Set Balance=5 / W5 单图 302 扣 5→4 / W5d 幂等重放不重复扣 / W7 ZIP 200 扣 4→3 / W6 同 key 异参 409 / W8 ZIP 402 / W9 Package 402 / W10 unlimited 302 不扣 / W11 admin_adjustment 流水 / W12a github-delete 闭环 / W12b 清理零残留。
- 2 FAIL = W0f（img1/img2 raw 传播等待，`last=404 after ~422s`）——与 PC-4 收口时 Owner 豁免裁定完全同因同象（本地 Node 轮询 raw 出网受限；同轮 **W7 ZIP 200** 再次反证 raw 从 workerd 可达）。**非产品缺陷，豁免继续有效。**

### 2.2 PC-5 注册链路 = 8 PASS / 0 FAIL（证据 `evidence-pc7-pc5-verify.md`）
- V0 就绪 / R1 有效注册 200 / R1b Worker 建号可见 / R1c **E2E 建号→GoTrue password-grant 登录闭环（PD-1 方案 A）** / R2 弱密码 400 / R3 非法邮箱 400 / R4 重复邮箱 400 防枚举 / R5 e2e5 零残留。

## 3. 前端 zh 模式全页面走查 = 12/12 全绿（本地 vite dev :4175 + Chrome 自动化）

逐页核对 zh 文案渲染 + console 检查：**全程零 console 错误、零缺 key 告警**（i18n 回落告警逻辑未触发）。

| 路由 | 要点 |
| --- | --- |
| `/` | 首页 Collection 卡 + 未归组资产区 |
| `/search` | 搜索 + 结果卡 |
| `/schedule` | Coming Soon（开关关闭态文案正确） |
| `/login` | 登录表单 + 提交成功回跳 |
| `/register` | **PC-5 改造版**表单/文案（gate 开态正常显示） |
| `/profile` | 资料 + 显示名称 |
| `/asset/ecosonique` | 详情 + `?lang=en` 静默回跳（V1.0 兼容）+ 下载面板成本透出 |
| `/admin` | 仪表盘统计 + **PC-6 平台控制卡**（Schedule/Registration 开关 + 3 价格 + 保存按钮）+ 语言分布 |
| `/admin/assets` | 列表 + 行内操作（含运行中沙箱 e2e 实体正常显示） |
| `/admin/tags`、`/admin/collections` | 创建/空态文案 |
| `/admin/users` | **10 用户 = 沙箱 e2e + demo01–08（user 角色正常）+ admin**；积分/无限列在位 |
| `/admin/audit-logs` | 过滤器 + 历史审计行 + JSON 元数据 |

走查期间管理员登录经**本地环回临时凭据文件**完成（页面 JS 运行时取用），文件随即删除 —— **零凭据进会话/Git/文档**。

## 4. 环境限制（如实标注，未伪造）

- **隔离库复跑不可行**：本机到 `db.ctddbmadywtdufazhwiq.supabase.co:5432` DNS `ENOTFOUND`（REST 443 正常、直连 Postgres 不通；与 PC-4 收口时确认的「无本地 Postgres」一致）。沿用历史证据：Phase A `v11-phase-a-smoke.mjs` 48/48、PC-2 冒烟 16/16、PC-4 隔离库冒烟 13/13（H2 幂等三态/unlimited 旁路/退款仅一次/grants 收敛，commit `7e89ae7`）。该部分待有隔离库环境时可随时补跑。
- G9 三视口响应式截图仍欠真实浏览器 QA 环境（V1.0 收口时的 pending，不在 PC-7 范围）。

## 5. 红线复核（静态 grep，2026-09-06）

- raw/public URL 直拼：`src` 内仅 `lib/image-source.ts`（`makeImageUrl`/`imageSrcOf` 唯一出口）✅
- 前端无残留 `supabase.auth.signUp`（PC-5 改投 Worker 后）✅
- `.env` / `.dev.vars` 未被 Git 跟踪（仅 `.env.example`）；跟踪文件无密钥串（唯一命中为 `security-scan.mjs` 的 JWT 正则定义）✅
- RLS 唯一真源 / service_role 仅 Worker / 两级可见性 / Storage 原件零触碰 —— 本轮未做任何 schema/RLS/Storage 变更 ✅

## 6. 沙箱后零残留独立复核 = CLEAN

- `assets?slug=like.e2e*` = 0；auth users 匹配 `e2e4/e2e5` 与 `@pc4.test/@pc5.test` = 0。

## 7. 结论与 STOP

- **PC-7 集成回归 PASS**（含一项已批环境豁免 W0f×2；一项环境受限的隔离库复跑以历史证据代位并如实标注）。
- **V1.1 Phase C 全部完成：PC-1→PC-7 CLOSED。** 本地 main 领先远端 8 commit，未 push。
- **STOP → 等 Owner 终验。** 生产部署（Worker/前端）始终单独授权、绝不自动。
