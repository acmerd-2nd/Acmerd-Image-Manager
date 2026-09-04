# V1.1 Phase B — Owner 对 PB-1 报告的裁决（原文存档）

- **日期**: 2026-09-04
- **裁决**: PB-1 Implementation ✅ PASS / Isolated Evidence ✅ PASS / Gate Closure 🟡 暂缓（待事实边界澄清）
- **澄清结果**: Stage 1/2 已实际执行 → 按 `09-factual-clarification-production-evidence.md` 重新提交 Production Evidence 后，PB-1 Gate Closure 成立
- **冻结项**: 本裁决 §1–§6 六项冻结 + "lease 不可被冲突重试替代"长期规则，已收录于 09 号文档 §5

---

这份 PB-1 报告我审完了。整体技术实现我认可，尤其是你们把之前我要求的 H3 真正落成了：

```text
GitHub 写入
→ lease
→ uploading
→ remote success
→ sha 校验
→ ready

删除：
ready
→ deleting
→ GitHub DELETE
→ 成功后 DB DELETE
```

以及 `19/19` 隔离库验证、Phase A `48/48` 回归、GitHub dry-run `14/14`，这些都足以说明 **PB-1 的实现本身已经达到验收水平**。

但是，这份报告现在有一个必须先解决的问题：

**报告内部存在“实施范围事实冲突”，所以我暂时不能正式给 PB-1 CLOSED。**

你在开头明确写的是：

> 生产库零触碰；生产 GitHub 仓库零写入；无部署执行。

而 §7 又写：

> dry-run e2e 全链路……`0009–0014 应用生产后`全链路重跑  
> Stage 1（生产 1 张图迁移）✅ Owner 授权执行  
> Stage 2 ✅ Owner 授权执行

这几个表述不能同时为真。

尤其“`0009–0014 应用生产后`”和“生产库零触碰”是直接冲突的。

这里需要你们先把事实讲清楚：

如果 §7 的 `✅ Owner 授权执行` **只是说已经获得授权，但实际上尚未执行**，那没有问题，可以把措辞改成：

```text
Stage 1：✅ Owner 已授权，待执行
Stage 2：✅ Owner 已授权，待执行（且 Storage cleanup 仍未授权）
```

同时把：

> 0009–0014 应用生产后全链路重跑

改成：

> dry-run / isolated environment 全链路重跑

或者明确写实际执行环境。

这样 **PB-1 可以正式关闭**。

但如果事实上已经执行了：

```text
Stage 1 = 生产图片已写入 GitHub
```

或者：

```text
Stage 2 = 生产 images.provider 已切换为 github
```

那就不能再把这份东西当成“PB-1 结束、未进入 Stage 1”的报告。

这种情况下，必须重新整理成：

```text
PB-1 CLOSED
+
Stage 1 EXECUTED
+
Stage 2 EXECUTED
```

并补齐对应的 Production Evidence。

尤其 Stage 2 一旦真的执行，就必须证明：

```text
provider = github
source_path 正确
线上 makeImageUrl 200
浏览器真实图片正常
V1.0 原对象仍保留
没有提前 cleanup
```

否则不能只写一句“Owner 授权执行”。

---

除此之外，我认可 PB-1 的技术结果。

特别是这几个点已经可以正式冻结：

**1. GitHub path**

```text
assets/{asset-uuid}/{langCode}/{filename}
```

正式固定，不使用 slug。

**2. Image status**

```text
uploading
ready
failed
deleting
```

公开查询只看 `ready`。

**3. GitHub write lease**

```text
resource_key = al:{asset_language_id}
TTL = 120s
```

用 Supabase 持久化 lease，而不是 Worker 内存锁。这解决了跨 isolate 的问题。

**4. GitHub SHA 校验**

不是收到 2xx 就直接 `ready`，而是：

```text
GitHub response.content.sha
==
本地 git blob sha
```

再进入 `ready`。

这个很好。

**5. Delete 一致性**

现在不是：

```text
DB DELETE
↓
GitHub DELETE
```

而是：

```text
ready
↓
deleting
↓
GitHub delete
↓
success / 404
↓
DB delete
```

失败保留 `deleting`，等待 sweeper。

这正好闭合我们之前担心的“DB 没了、GitHub 还在”的问题。

**6. Sweeper**

这个也可以正式成为 V1.1 基础设施：

```text
uploading expired
failed orphan
deleting
```

都拥有收敛路径。

---

另外有一点我建议记成长期规则：

**GitHub Contents API 的冲突重试可以作为“异常恢复”，但不能替代 lease。**

现在你们是：

```text
Lease
+
409/422 fallback
```

这个正确。

不要未来为了“看起来能解决冲突”而取消 lease。

---

所以我现在的 Gate 判断是：

**PB-1 Implementation：✅ PASS**

**PB-1 Isolated Security/E2E Evidence：✅ PASS**

**PB-1 Gate Closure：🟡 暂缓一项，待消除报告中的生产执行范围冲突**

你只需要让 Agent 澄清 §7 的两句话究竟是：

> “已授权但未执行”

还是：

> “已经实际执行”。

如果是前者，我会直接认为 **PB-1 CLOSED**，然后你们按原计划进入 Stage 1。

你可以直接发给 Agent：

> **PB-1 技术实现与隔离验证通过。暂不宣布 Gate Closure，先修正报告中的执行范围矛盾。**
>
> 报告 §1 写明“生产库零触碰、生产 GitHub 仓库零写入、无部署”，但 §7 同时出现“0009–0014 应用生产后全链路重跑”以及“Stage 1 / Stage 2 ✅ Owner 授权执行”。
>
> 请明确区分：
>
> 1. Owner 已授权
> 2. 已实际执行
> 3. 已部署
>
> 若 Stage 1/2 仅获授权、尚未执行，请将状态改为“Authorized / Pending Execution”，并确保所有全链路测试仍明确发生在 dry-run/隔离环境。
>
> 若 Stage 1/2 已实际执行，则必须停止当前 PB-1 收口，重新提交 Production Execution Evidence，不得继续以“生产零触碰 / PB-1 only”表述。
>
> 澄清完成后再宣布 PB-1 Gate Closure。

这不是吹毛求疵，而是你们现在已经建立了比较严格的工程证据体系之后，**“实际执行了什么”和“理论上授权了什么”必须严格分开。**

从技术实现本身看，我是满意的。现在只差把这份报告里的事实边界对齐。
