# V1.1 Design Gate — Owner 裁决原文（落档）

> **裁决日期**: 2026-09-04
> **裁决结论**: ✅ **V1.1 Design Gate APPROVED WITH REQUIRED ADJUSTMENTS**
> **性质**: 本文件为 Owner 裁决原文的逐字落档（Phase 7 附录 A1–A6 先例范式），后续实施与回归均以本文为裁决依据。
> **原文引用说明**: 以下为 Owner 审阅 `docs/v1.1/01-design-gate.md`（Rev A）后的裁决原文，未做任何改写。

---

我审完这份 V1.1 Design Gate 了。整体方向可以进入实施，但我不建议"原样批准"。这里有几个会直接影响后续返工的架构点，其中有两个我认为必须在开工前修正。

先给结论：

**V1.1 Design Gate：有条件批准。**

D1、D2、D3、D5、D6、D7、D8、D10、D11、D12 基本通过；D4 需要加明确的 GitHub 仓库风险约束；D9 和 Credits 相关设计需要做关键修正；另外 Collection Cover 需要补一个数据库完整性约束。

最重要的问题之一是你们 §5.2 对注册流程的定义：

> `POST /api/auth/register` → service role 调 GoTrue admin create user → 返回 session

这个地方不能直接按现在的设计实施。Supabase 当前官方的 Admin `createUser()` 文档定义的是"创建用户"的 Admin API，并明确要求服务端使用 secret/service role；它并不是一个直接返回用户登录 session 的接口。

所以这里应该改成：

```
Register
 ↓
Worker
 ↓
check registration_enabled
 ↓
Admin API create user
 ↓
确认/创建 profile、role、credit account
 ↓
返回"注册成功"
 ↓
前端进入 Login
```

或者，如果你强烈希望"注册完成自动登录"，就让 Agent 另外设计一个经过实际验证的"创建用户 → 建立 session"流程，不要把 `createUser()` 本身假设成能返回 session。

另外，既然你现在明确要求 `registration_enabled = false` 时真正关闭公开注册，那么 GoTrue 本身也可以关闭 `Allow new users to sign up`；Supabase 官方文档确认这个设置关闭后，新用户不能通过常规 signup 创建，只能让已有用户登录。

所以你现在的：

```
GoTrue signup off
+
Worker registration gate
```

方向是对的，但**必须把 Worker "注册成功后的 session 语义"重新设计清楚。**

---

第二个我认为必须修的是 Credits 的幂等。

你现在写：

> `credit_transactions.idempotency_key UNIQUE`

这个方向没问题，但"命中唯一约束 → 返回首次结果"不能只靠数据库唯一键自动发生。

例如第一次：

```
key = ABC
amount = 1
```

然后客户端因为网络重试，再发：

```
key = ABC
amount = 1
```

应该返回第一次扣分的结果。

但如果恶意或者 bug 造成：

```
key = ABC
amount = 15
```

就不能返回"首次结果"而不检查参数一致性。

所以 `deduct_credits()` 的幂等协议建议明确为：

```
idempotency_key
+
user_id
+
type
+
amount
+
reference
```

第一次成功：创建 ledger
重复相同请求：返回原结果
相同 key 但业务参数不一致：409 IDEMPOTENCY_CONFLICT

这个我建议写进 V1.1 的硬规则。

---

第三个非常重要的问题是 ZIP 的退款设计。

现在设计：

```
扣分
 ↓
开始 ZIP
 ↓
流中失败
 ↓
download_refund
```

方向正确，但 `download_refund` 也必须幂等。

否则：

```
ZIP failure
 ↓
refund
 ↓
浏览器 retry
 ↓
又 refund
```

就可能把积分凭空加回来。

所以必须建立：

```
debit transaction
        ↓
refund reference
```

一个 debit 最多对应一个成功 refund。

我建议 `credit_transactions` 再强化一个关系语义，例如：

```
metadata.original_transaction_id
```

或者单独增加明确的 `reference_type/reference_id` + 唯一 refund key。

这属于 Credits 必须在落库前锁死的设计。

---

第四个问题是：**`credit_transactions.user_id ON DELETE CASCADE` 我不建议。**

因为你后面的用户永久删除策略是：

```
delete auth.users
 ↓
cascade
 ↓
credit_transactions 全没
```

那么"积分历史"会随着用户直接消失。

这和你的 Admin 用户管理里"View Credit History"其实存在冲突。

我更建议：

```
credit_transactions.user_id
→ ON DELETE SET NULL
```

同时 ledger 本身继续保留。

这样：

```
User 被永久删除
↓
个人账户消失
↓
Credit Account 消失
↓
Credit Ledger 保留
↓
user_id = null
```

同时每条流水保留：

```
reference
type
amount
balance_after
metadata
created_at
```

这样仍然可以做审计、财务式追溯，又不会保留完整用户账户。

如果你担心隐私，可以让 `metadata` 保留删除前必要的匿名化快照，而不是直接留下邮箱。

这个设计我比较推荐。

---

第五个问题是 Collection Cover。

你现在：

```
collections.cover_image_id
    ↓
images.id
```

只能保证"这个 image 存在"。

但是不能保证：这个图片属于当前 Collection 里的 Asset。

例如：

```
Collection A
 ↓
cover_image_id = Collection B 下的某张图片
```

数据库完全有可能允许。

Phase 3 你们已经给 Asset Cover 加过同资产约束，所以 Collection 应该沿用同一思路：

```
collection.cover_image_id
 ↓
image
 ↓
asset
 ↓
asset.collection_id = collection.id
```

建议在 0009 里加一个数据库 trigger 做这个完整性约束。

这是我认为应该直接加入当前 Gate，而不是以后修。

---

第六个问题是 Image Repository，我批准，但要把"GitHub 是存储层，不是 CDN"这个风险正式写进 V1.1。

你现在的模型：

```
Supabase = Metadata / Auth / Business Logic
GitHub   = Image Binary
```

是成立的。

GitHub 官方 Contents API 可以用于创建、更新、删除仓库里的文件，而且要求使用拥有 Contents 写权限的令牌；同时官方明确提醒，创建/删除文件的并发操作会发生冲突，所以这类操作需要串行或经过严格的并发控制。

这意味着 Agent 的：

```
Browser
 ↓
Worker
 ↓
GitHub Contents API
```

方案是对的。

但是我建议加三条硬约束：

```
GITHUB_TOKEN 只在 Worker Secret

Admin Upload 同一个 Asset/Language 的写入必须串行

GitHub API 失败时，DB image row 不得先落为成功状态
```

否则很容易：

```
GitHub 上传失败
+
DB 已写 image
=
幽灵图片
```

另外，`source_url` 我建议**不要作为核心事实字段**。

你现在的 `provider / source_path / source_url`，其中 `source_url` 属于衍生值。

我更建议 `provider / source_path`，然后统一 `makeImageUrl(image)` 动态计算最终 URL。

如果未来 CDN 前缀、commit-pinned URL、jsDelivr 或其他出口改变，就不用批量更新数据库。

---

第七个问题是 GitHub 图片迁移，我支持你的"先复制、验证、最后才删 Supabase"策略，但我建议把它升级为真正的两阶段迁移：

```
Stage 1
Supabase → GitHub → HEAD/Hash 校验 → Migration Report

Stage 2
DB provider 切换 github → 线上 read verification → 再进入 Storage cleanup
```

不能"上传 GitHub → 立刻删除 Supabase"。

你现在只有 1 张生产图片，所以第一次迁移风险极小，正好拿它做完整演练。

---

第八个问题是 Collection 的"无归组 Asset"。

你现在设计"不属于任何 Collection 的 published Asset → 首页'更多资源'未分组区"，我**批准**，而且我认为比"所有 Asset 必须加入 Collection"更灵活。

这样迁移老数据的时候 `collection_id = null` 完全合法，不会因为 V1.1 上线而强迫老资源重新分类。

首页结构可以是：

```
Collections → Collection Cards
More Resources → Asset Cards
```

这样也保持 `/asset/:slug` 完全兼容。

---

第九个问题是 Schedule。

我赞成 `schedule_navigation_enabled`，但我不建议"OFF 时 `/schedule` 完全不渲染内容"做成一种特殊权限逻辑。因为这以后非常容易变成 `nav disabled = page forbidden`。

我建议简单定义成：

```
OFF → public nav hidden → /schedule returns a lightweight Coming Soon / unavailable state
ON  → normal Schedule page
```

这样页面本身有明确的产品状态，而不是 404/403。

当然，如果你明确希望"完全关闭页面"，也可以做，但不要把它误认为安全控制，它只是产品显示策略。

---

第十个问题是 i18n。

D2 我批准。`src/i18n/zh.ts / en.ts / index.ts` 对这个阶段非常合适。

但是我建议加一条：**新建的任何 V1.1 UI 必须从第一天就使用 i18n key。**

不要"Phase 1 先写中文，Phase 2 再统一国际化"，否则到后面 Admin、Credits、Collection、Schedule 全部变成第二次大型改造。

语言状态最终还是 `uiLocale ≠ assetLanguage`，这是冻结规则。

---

关于 D1–D12，我最终建议你给 Agent 的正式裁决是：

```
D1  ✅ 数据模型 → 业务逻辑 → UI → 回归
D2  ✅ 轻量 i18n，不引框架
D3  ✅ provider + source_path 保留旧 storage_path 兼容；source_url 作为衍生值，不作为核心事实
D4  ✅ with risk lock
    采用 GitHub Image Repository
    GitHub token 仅 Worker Secret
    串行/受控写入
    继续评估大陆可访问性
    不提前引入 R2 / Worker 图片代理
D5  ✅ Collection 单层 / collection_id 可空 / 保持 /asset/:slug
D6  ✅ site_settings + Platform Controls，不恢复完整 Settings
D7  ✅ credit_accounts + credit_transactions 独立模型
D8  ✅ with required changes
    Atomic RPC
    Idempotency
    Refund 必须幂等
    相同 key 参数冲突必须 409
    禁止应用层 SELECT→UPDATE 扣分
D9  ✅ with required correction
    Worker 作为公开注册入口
    但重新设计"注册成功后的 session"行为
    不能假设 admin.createUser() 直接返回 session
D10 ✅ Seed Users + permanent delete；但 credit_transactions 不建议 cascade delete
D11 ✅ 24 → 34+ allowlist，补齐 V1.1 实际需要的 user.deleted / collection.* / credits.* / settings.*
D12 ✅ 0009+ 分批 migration / NO-DRIFT / /asset/:slug 永久兼容
```

然后我建议再增加三个**非编号硬约束**：

```
H1 Collection Cover 必须有"属于当前 Collection"数据库级约束
H2 Credits idempotency 必须验证：
   same key + same request → same result
   same key + different request → conflict
H3 GitHub Image 写入必须遵循：
   remote success → DB success
   remote failure → DB failure
   不得产生幽灵 image row
```

---

最后，还有一个我认为值得明确的产品细节：

你原始需求说的是"每次下载图片都消耗 1 积分，打包下载消耗 15 积分"，这句话和现在 Agent 设计的：

```
单张下载 1
多选 ZIP 10 张 → 10
整套网盘 → 15
```

已经产生了新的语义。

这个我目前**批准**，因为它最公平、最容易理解，也和"具体消耗多少积分由后台调控"兼容。

但是一定要在产品规格里写死：**ZIP 消耗的是"所选图片数量 × ZIP 单张成本"，不是固定 15。**

否则以后管理员看到 `ZIP Download Cost` 很容易以为 ZIP 永远是 15。

我甚至建议后台名称直接叫：

```
Single Image Cost
ZIP Per-image Cost
Package Download Cost
```

---

因此，我给这一版的最终状态是：

**✅ V1.1 Design Gate APPROVED WITH REQUIRED ADJUSTMENTS**

不是阻塞整个项目，而是要求 Agent 在开始 Phase A 之前，把上面这些点更新进 Gate，尤其是：**注册 session 语义、Credits 幂等/退款、credit ledger 删除策略、Collection Cover 完整性**。这四个如果现在锁死，后面返工概率会明显低很多。
