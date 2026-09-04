# V1.1 Phase C Design Gate — UI 层 + Credits 接线 + 注册 Gate + Seed 用户

- **日期**: 2026-09-05
- **状态**: 🔴 **PENDING OWNER REVIEW**（纯文档 Gate；Owner 批准前零代码改动、零生产库触碰、零部署）
- **前置**: Phase B = CLOSED（PB-1 Gate Closure 见 `09-factual-clarification-production-evidence.md`；Stage 1 VERIFIED、Stage 2 线上运行，Storage cleanup 🚫 未授权未执行）
- **依据**: V1.1 提案 §52/§57–§62/§69/§71（Phase C = UI）；Rev B（01）与 Phase B Gate（04）所有冻结不变量继续有效

---

## §0 现状盘点（Gate 结论的事实基础，均已核对）

**数据层（Phase A/B 已就位，Phase C 不改 schema，除非裁决必改）：**
- `collections` 表 + RLS（0012）：anon 读 published；admin 增删改 ✅
- `credit_accounts`（balance/unlimited）+ `credit_transactions`（ledger，idempotency_key 唯一）✅
- `deduct_credits` RPC（0010）：H2 幂等三态 + **unlimited 旁路（不扣分、不写扣账流水）** + C6 无负余额 ✅
- `site_settings` 5 key（0011）：`registration_enabled=true` / `schedule_navigation_enabled=false` / `single_image_download_cost=1` / `zip_download_cost_per_image=1` / `package_download_cost=15`；**anon/authenticated 可 select，写仅 service_role** ✅
- `profiles.account_origin`（`registered|seed`，D10）✅
- images.status 四态 + provider/source_path 双模型（0014）✅

**业务层缺口（Phase C 要补的接线）：**
- **Worker 目前 0 处调用 credits RPC**——下载链路完全不扣分（grep 证实），这是 Phase C 最重的安全接线
- 注册仍直连 GoTrue signup，无 `registration_enabled` 后端 gate
- 前端无 Collection UI、无 Schedule 导航、无积分显示、i18n 仅有 skeleton（zh/en/index）
- Admin 无 Platform Controls、无积分管理列、8 个 seed 用户未创建

## §1 Phase C 范围分解与停止点

| 子阶段 | 内容 | 完成后 |
| --- | --- | --- |
| **PC-1 i18n 全量接线** | 所有组件文案 → i18n key；默认 zh-CN；左上角 Apple-style 中英 Switch；`uiLocale`(localStorage `acmerd.ui.locale`) 与 `assetLang`(?lang=) 完全隔离；切换不刷新页面 | 连续实施 |
| **PC-2 Collection UI** | 首页 Collection 卡片 → `/collection/:slug` Asset 列表；Admin CRUD + 排序 + 归档 | 连续实施 |
| **PC-3 Schedule** | 导航"排期"（settings 开关控制显隐）+ 页面（Coming Soon）+ Admin 开关 | 连续实施 |
| **PC-4 Credits 下载接线** | Worker 单图/ZIP/Package 扣分（§2，最高风险项）+ 前端余额显示/不足提示 | **STOP → Owner 检查**（隔离库+沙箱全矩阵证据） |
| **PC-5 Registration Gate** | Worker 注册端点 gate `registration_enabled`（§4）+ 前台文案 | 连续实施 |
| **PC-6 Platform Controls + Seed 用户** | Admin 控制区（4 开关/价格）+ demo01–08 创建（§5） | 连续实施 |
| **PC-7 集成回归** | V1.1 全量回归（Phase D 性质的矩阵，含 Phase A 48/48 与 PB e2e 复跑） | **STOP → Owner 终验** |

纪律：PC-4 必须先在**隔离库 + dry-run 沙箱**过全矩阵再谈生产；生产部署/切换单独 Owner 授权（沿用 PB 节奏）。

## §2 PC-4 Credits 下载扣分接线（核心设计，Owner 必读）

**总纲 §37/§38 铁律**：扣分只在服务端原子完成，前端无任何扣分路径。全部复用 0010 RPC，**零新 RPC、零 schema 变更**。

### 2.1 单图下载 `GET /api/downloads/image/:id`

```
requireUser（登录门，现状不变）
→ published 双层 + status='ready' 校验（现状不变）
→ 读 single_image_download_cost
→ select deduct_credits(user,'image_download',cost,ref='image:{id}',idempotency_key,meta)
    ├─ unlimited=true → RPC 旁路，不扣分
    ├─ 余额不足 → RPC raise → Worker 返回 402 {code:'insufficient_credits', required, balance}
    └─ 成功 → 302 raw/CDN（provider-aware，现状不变）
```

- **不加 raw HEAD 探针**：`status='ready'` 已是 sha 校验后的成功态（PB 冻结），单图 302 前再 HEAD 一次是多余子请求。 Owner 若要求"确认对象可读取后再扣"（总纲 §45 字面），可改为 HEAD 后扣——**Q1 裁决点**，默认不加。
- **idempotency_key**：前端每次点击生成 uuid，随请求头 `X-Idempotency-Key` 透传 RPC（H2：同 key 同参→原结果，同 key 异参→409）。前端按钮 loading 态防双击；**不做服务端时间窗去重**（H2 已覆盖重放；时间窗会误伤真实重复下载）。**Q2 裁决点**。

### 2.2 ZIP 下载 `POST /api/downloads/zip`

```
requireUser → 选中图片 id 列表（≤30）
→ 预检：DB status='ready' + published 双层 + 每图 raw HEAD（复用 PB 预检，加 HEAD 确认可达）
→ cost = n × zip_download_cost_per_image
→ deduct_credits(user,'zip_download',cost,ref='zip:{batch-uuid}',key)
→ 流式打包（现状不变）
→ 打包中途网络异常（已扣分未送达）→ 自动 refund（一 debit 一 refund 冻结语义，refund RPC 已就位）
```

### 2.3 Package 下载

```
requireUser → source 校验 → deduct_credits(user,'package_download',package_download_cost,ref)
→ 返回/302 网盘链接。跳转即消耗，不追退款（总纲 §46 冻结，无争议）。
```

### 2.4 前端

- 登录后右上角余额徽标：`◉ 42` / unlimited 显示 `♾`（读 `credit_accounts` 自行 RLS select，无新端点）
- 下载按钮成本透出（总纲 §58/§59）：单图旁 `1 credit`、ZIP 底栏 `5 images · Cost: 5 credits`、Package `15 credits`——cost 从 settings 读，不写死
- 余额不足：不发起扣分请求前前端已可预判置灰，后端 402 兜底；提示文案走 i18n key（`credits.insufficient`）
- Admin Users 页：Credits 列 + Set Balance（直接设定值，非 ±）+ Unlimited 开关 → Worker admin 端点 → `adjust_credits` RPC + 审计 `credits.adjusted`（含 from/to/reason metadata，总纲 §60）

## §3 PC-2 Collection UI 设计

- **路由**：`/` 首页改列 published Collection 卡片（cover = `cover_asset_id` 首 ready 图经 makeImageUrl，无图用占位）；`/collection/:slug` 列该 collection 下 published Asset；Asset 详情链路不变（Asset → Language → Image）
- **锁死边界（总纲 §20）**：Collection 只是组织容器，无 language/image/download 语义
- **Admin**：Collections 管理页（create/update/archive/delete/sort_order 拖拽排序、设 cover_asset）；RLS 已就位，走 Worker admin 端点保持"原子 mutation + 审计"范式
- **无归属 Asset**（`collection_id=null`）：**Q3 裁决点**——默认：首页只展示 Collection；未归属 Asset 仅 Admin 可见不进公域浏览（可在 Admin 拖入 Collection）。现有生产 1 图所属 asset 建一个默认 Collection 收纳。

## §4 PC-5 Registration Gate（Worker 入口，总纲 §49）

- 新端点 `POST /api/auth/register`：Worker 校验 `registration_enabled` → false 返回 403 `{code:'registration_disabled'}`；true → service_role GoTrue `admin.createUser`（email+password）→ 返回会话/确认提示
- 前端注册页改投 Worker 端点；开关关闭时**保留按钮**，点击弹提示"当前暂未开放注册 / Registration is currently unavailable"（总纲 §48）
- **Admin 不受开关影响**：Admin 建用户/恢复走既有 admin 端点，与注册开关正交（总纲 §50）
- **Q4 裁决点**：GoTrue 邮箱确认流程——默认沿用项目 GoTrue 现状（若未开邮箱确认则注册即登录）；Worker 不改变 GoTrue 配置

## §5 PC-6 Platform Controls + Seed 用户

- **Platform Controls**（Admin Dashboard 顶部区域，总纲 §52）：Schedule Navigation 开关、Registration 开关、三个 cost 数字输入。写路径 = Worker admin 端点（service_role update site_settings + `admin` 角色校验 + `settings.updated` 审计）；不恢复完整 Settings 系统
- **Seed 用户（总纲 §62/§63）**：实施窗口内一次性脚本创建 demo01–08（service_role admin API），`account_origin='seed'`、credits=0、unlimited=false、role=user；**密码随机生成，只写入本地一次性文件当面交 Owner，绝不入 Git/chat/文档/记忆**（红线沿用）；脚本本体入 Git 但不含任何凭据
- seed 用户不是特殊权限类别，仅 account_origin 字段不同，Admin 可正常改密/禁用/删除

## §6 PC-1 i18n 接线计划

- 命名空间（总纲 §7 为底线，按下表扩展）：`nav.*` `auth.*` `download.*` `credits.*` `collection.*` `schedule.*` `admin.*` `errors.*` `common.*`
- 组件改造：全部页面/组件硬编码文案 → `t(key)`；`src/i18n/{zh,en}.ts` 为唯一文案源，不引重型框架（保持 Phase A skeleton 的轻量实现）
- Switch 控件：左上角 `中 [⬤──] EN`，苹果风格；`uiLocale` 存 localStorage `acmerd.ui.locale`；默认 zh-CN；切换即时生效不刷新（React context）
- **铁律**：`uiLocale ≠ assetLang`。URL `?lang=` 语义永不变更（V1.0 兼容）；切 UI 语言不影响当前浏览的 Asset Language

## §7 非目标（明确排除）

- Storage cleanup（🚫 未授权）｜R2/S3/CDN 切换（仅保留 env 空口）｜多层 Folder｜完整 Settings 系统｜用户自助积分历史 UI（V1.1 ledger 仅 Admin 可见）｜Schedule 内容编排（`schedule.items` 未来再说）｜重 i18n 框架

## §8 待 Owner 裁决（Q1–Q5）

| # | 问题 | Agent 建议 |
| --- | --- | --- |
| Q1 | 单图扣分时机：302 前是否加 raw HEAD 探针确认可达？ | **不加**（ready 态已含 sha 校验；省子请求）。总纲 §45"确认可读取"由 ready 语义满足 |
| Q2 | 下载幂等 key 策略 | 前端每次点击 uuid 透传 RPC；不做服务端时间窗去重；防双击靠前端 loading 态 |
| Q3 | `collection_id=null` 的 Asset 公域可见性 | 首页只列 Collection；无归属 Asset 不进公域，仅 Admin 可见 |
| Q4 | 注册邮箱确认 | 沿用 GoTrue 现状配置，Worker 不改 GoTrue 行为 |
| Q5 | PC-4 验证环境 | 隔离库 + dry-run 沙箱全矩阵（含并发双击、unlimited、不足、refund 路径）PASS 后 STOP，生产部署单独授权 |

## §9 风险评估

1. **扣分与 302 之间进程死亡** → 钱扣了链接没拿到：概率极低（两句之间无 await GitHub 调用）；靠 ledger 可人工 refund 兜底，不建自动补偿（避免过度设计）
2. **ZIP 扣分成功但打包中途失败** → 自动 refund 路径必须有隔离库测试覆盖（总纲 §45 明示）
3. **cost 配置即时生效** → settings 每次请求实时读，改价即生效（总纲 §35）
4. **i18n 漏网文案** → PC-7 回归加"zh 模式全页面走查"项；`t()` 缺 key 回落 en 并 console.warn
5. **注册 gate 绕过** → 前端只是提示层，真正 gate 在 Worker（403）；GoTrue 直连 signup 路径必须在前端移除（直连 anon key 仍可打 GoTrue——**残余风险**：若 Owner 要求绝对关闭，需 GoTrue 侧禁用公开 signup 或 Worker 独占 signup key，**Q4 附带裁决点**）

---

**Gate 纪律重申**：本文件批准前，不改任何代码、不动生产库、不创建 seed 用户。批准后按 §1 顺序执行，PC-4 完成即 STOP 等 Owner 检查。
