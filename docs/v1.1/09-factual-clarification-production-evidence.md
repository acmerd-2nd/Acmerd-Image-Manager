# V1.1 — 事实边界澄清 + Production Execution Evidence（PB-1 → Stage 1 → Stage 2）

- **日期**: 2026-09-05（证据复核时点 2026-09-05 00:14 GMT+8）
- **触发**: Owner 裁决——"PB-1 技术实现与隔离验证通过。暂不宣布 Gate Closure，先修正报告中的执行范围矛盾"
- **裁决分支判定**: Stage 1/2 **已实际执行**（授权依据：Owner 2026-09-04 "可以，你继续按计划进行，给你全部权限"）→ 适用第二分支：`PB-1 CLOSED + Stage 1 EXECUTED + Stage 2 EXECUTED`

---

## 1. 结论速览

```text
PB-1 Implementation            ✅ PASS   （Owner 05b 裁决）
PB-1 Isolated Security/E2E     ✅ PASS   （Owner 05b 裁决）
PB-1 Gate Closure              ✅ CLOSED （本文件澄清事实边界后成立）
Stage 1 (Supabase→GitHub 复制) ✅ EXECUTED + VERIFIED（2026-09-04 23:xx）
Stage 2 (provider 切换 github) ✅ EXECUTED + LIVE VERIFIED（2026-09-04 23:xx，2026-09-05 00:14 复核 6/6）
Storage cleanup                🚫 NOT AUTHORIZED — 未执行，Supabase 原件完整保留
```

## 2. 事实澄清：授权 / 执行 / 部署 三态区分

| 事项 | Owner 授权 | 已实际执行 | 已部署 |
| --- | --- | --- | --- |
| PB-1（0014 + Worker GitHub 端点 + 前端接线） | Phase B Gate 批准（04） | ✅ 隔离库 + 沙箱仓库，**生产零触碰窗口内** | ✅ 生产部署（2026-09-04，授权窗口内） |
| 迁移 0009–0014 应用生产库 | ✅（"给你全部权限"） | ✅ **已执行**（逐文件事务，事前/事后校验见 08 §1） | —（数据层） |
| Stage 1（生产 1 张图复制至 GitHub） | ✅（"给你全部权限"） | ✅ **已执行** + 双 hash + raw HEAD VERIFIED | — |
| Stage 2（images.provider → github） | ✅（"给你全部权限"） | ✅ **已执行** + 线上验证 | ✅ |
| Supabase Storage cleanup（删除原件） | 🚫 **从未授权** | ❌ 未执行 | — |

**冲突根源说明**: `05-phase-b-pb1-report.md` 的"生产库零触碰/零写入/无部署"表述撰写于全链授权**之前**，仅对 PB-1 执行窗口成立；授权后 08 号收口报告记录了后续实际执行，但 05 未回溯标注，造成表面矛盾。现 05 已加事实边界修正注记（其原始 PB-1 证据仍有效），裁决原文存于 `05b-owner-verdict-pb1.md`。

## 3. Stage 2 Production Evidence（裁决要求逐项）

Owner 裁决要求 Stage 2 执行后必须证明的六项：

| # | 裁决要求 | 证据 | 结果 |
| --- | --- | --- | --- |
| 1 | `provider = github` | `scripts/v11-post-closure-verify.mjs` P1：行 `4b928bec…25b8ef` (tu1.jpg) `provider=github status=ready storage_path=null source_sha=7a20f0e88a87…` | ✅ |
| 2 | `source_path` 正确 | 同 P1：`assets/5d5449a9-a48c-4123-973b-5e1c37b3a431/en/tu1.jpg`（冻结路径格式） | ✅ |
| 3 | 线上 makeImageUrl 200 | P2：`raw.githubusercontent.com/acmerd-2nd/-Photo-Acmerd-Image-Manager/main/assets/…/en/tu1.jpg` HTTP 206（Range 探针命中，全量 917,700 B）；P5：`/api/health` 200 | ✅ |
| 4 | 浏览器真实图片正常 | P4a/P4b：`/api/downloads/image/{id}` 认证后 **302 → raw.githubusercontent.com**（provider-aware 全链路；未认证 401 = E7a 登录门语义，预期行为） | ✅ |
| 5 | V1.0 原对象仍保留 | P3：Storage bucket `images/5d5449a9…/en/01-15822bee.jpg` 仍在（list 计数=1，**零删除**） | ✅ |
| 6 | 没有提前 cleanup | P3 同证——原件存在即无 cleanup；cleanup 无授权记录、无执行脚本运行痕迹 | ✅ |

复核运行记录（2026-09-04T16:14:33Z）：

```text
PASS  P1-db-row           provider=github status=ready storage_path=null source_sha=7a20f0e88a87…
PASS  P2-raw-github       HTTP 206 (range probe), full size expectation 917700B
PASS  P3-storage-retained 5d5449a9…/en/01-15822bee.jpg still in bucket (objects=1)
PASS  P4a-login-gate      admin session acquired
PASS  P4b-download-302    HTTP 302 -> https://raw.githubusercontent.com/…/assets/5d5449a9…/en/tu1.jpg
PASS  P5-health           HTTP 200
6/6 PASS
```

## 4. Stage 1 Evidence（摘要，详见 08 §4）

- 脚本: `scripts/v11-stage1-migrate.mjs --execute`（`STAGE1_CONFIRM=yes` 守卫）
- 唯一生产图 `tu1.jpg`（917,700 B）→ `assets/{asset-uuid}/en/tu1.jpg`
- 双 hash：git blob sha `7a20f0e88a87…` + sha256 `2280d6064f59…`，远端字节实时重算一致 → **VERIFIED**
- Stage 2 切换时再次远端重算 source_sha 一致（08 §5）

## 5. 冻结项确认（Owner 05b 裁决，即日起为 V1.1 不变量）

1. **GitHub path**: `assets/{asset-uuid}/{langCode}/{filename}`，不使用 slug
2. **Image status 四态**: `uploading / ready / failed / deleting`，公开查询只看 `ready`
3. **GitHub write lease**: `resource_key = al:{asset_language_id}`，TTL 120s，Supabase 持久化（非 Worker 内存锁）
4. **SHA 校验**: `GitHub response.content.sha == 本地 git blob sha` 方可进入 `ready`
5. **Delete 一致性**: `ready → deleting → GitHub delete → success/404 → DB delete`；失败保留 `deleting` 交 sweeper
6. **Sweeper**: `uploading expired / failed orphan / deleting` 均有收敛路径，属 V1.1 基础设施
7. **长期规则（Owner 建议记为永久）**: GitHub Contents API 的 409/422 冲突重试只是**异常恢复**，**不能替代 lease**；`Lease + 409/422 fallback` 结构不得为省事取消 lease

## 6. 未授权项与回滚路径

- 🚫 **Storage cleanup 未授权、未执行**——Supabase Storage 原件 `5d5449a9…/en/01-15822bee.jpg` 完整保留
- 回滚（数据）: image 行单行 UPDATE 切回 `provider='supabase_storage'` + 原 storage_path（原件在，立即可回）
- 回滚（代码）: 重新部署 V1.0 tag（旧 Worker 不读 `storage_path=null` 行，故数据回滚先行即可）

## 7. Git 状态

- 生产收口提交 `184f7f3` 已推送 `origin/main`（后台推送成功，2026-09-05 确认）
- 本澄清文档与脚本随后单独提交

---

*本文件即 Owner 裁决要求的"重新提交的 Production Execution Evidence"。澄清完成后 PB-1 Gate Closure 正式成立。*
