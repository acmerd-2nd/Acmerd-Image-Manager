# V1.1 Phase B 收口报告 — 生产迁移应用 · e2e 全链路 · 部署 · Stage 1/2 上线

- **时间**: 2026-09-04 22:52–23:1x (GMT+8)
- **授权**: Owner "可以，你继续按计划进行，给你全部权限"（= PB-1 ACCEPTED + 迁移应用 + Stage 1/2 全链授权）
- **纪律**: Supabase 原件**零删除**；所有变更可回滚（provider 切回 supabase_storage + 恢复 storage_path 即回到 V1.0 数据形态）

## 1. 0009–0014 应用生产库 ✅

`scripts/apply-migrations.mjs`（逐文件事务，失败即停）：

```
事前: {"new_tables":"0","image_cols":"0","rpcs":"0","settings_rows":-1}
✅ 0009_v11_foundation.sql … ✅ 0014_phase_b_github.sql
事后: {"new_tables":"5","image_cols":"4","rpcs":"5","settings_rows":"5"}
```

## 2. e2e 全链路重跑 ✅ 27 PASS / 0 FAIL

本地 `wrangler dev` + 沙箱仓库（迁移应用后 E3–E10 全部转正）：
上传（lease → uploading → PUT → **response sha 校验** → ready）、路径冻结断言、raw HEAD、行状态断言、**E7a 未认证 401（登录门）/ E7b 认证后未发布 404（可见性守卫）**、四态删除闭环（ready → deleting → 远端 DELETE → 删行）、GitHub 对象移除、布景自动清理（审计落档证实）。direct 矩阵 14/14 仍全绿。

## 3. 部署 ✅

- `wrangler secret put GITHUB_TOKEN`（stdin 管道，凭据未落任何日志/文档）
- `wrangler.toml` vars: `GITHUB_IMAGES_OWNER=acmerd-2nd` / `GITHUB_IMAGES_REPO=-Photo-Acmerd-Image-Manager` / `BRANCH=main`
- 前端重建 bundle **`index-C_-skktm.js`**（原 V1.0 `index-DosBFCeX.js`）
- `wrangler deploy` → 线上 `/api/health` 200，首页引用新 bundle

## 4. Stage 1 — Supabase → GitHub 复制 ✅ VERIFIED

`scripts/v11-stage1-migrate.mjs --execute`（STAGE1_CONFIRM=yes）：

| Image | 源 | 目标 | 结果 |
| --- | --- | --- | --- |
| `4b928bec…25b8ef` (tu1.jpg, 917,700 B) | `images/5d5449a9…/en/01-15822bee.jpg` | `assets/5d5449a9-a48c-4123-973b-5e1c37b3a431/en/tu1.jpg` | ✅ 双 hash + raw HEAD 全 VERIFIED |

**Supabase Storage 原件保留（零删除）**。

## 5. Stage 2 — provider 切换 + 线上验证 ✅

单行 UPDATE（pg，Owner 授权运维操作）：`provider='github'`, `source_path=assets/{uuid}/en/tu1.jpg`, `storage_path=NULL`, `source_sha=7a20f0e88a87…`（远端字节实时重算，与 Stage 1 一致）, `status='ready'`。

| # | 验证项 | 结果 |
| --- | --- | --- |
| V1 | 游客视角（anon RLS）可见 github 行 | ✅ |
| V2 | `published_assets` 视图完好（ecosonique） | ✅ |
| V3 | **下载 302 → `https://raw.githubusercontent.com/…/tu1.jpg`**（provider-aware 全链路） | ✅ |
| V4 | raw 匿名 HEAD 200（917,700 B，public 仓库语义成立） | ✅ |
| V5 | 线上 `/api/health` 200 | ✅ |

## 6. 当前生产形态

- **数据**: 迁移 0001–0014 全 applied；1 张图片行 `provider=github` + source_sha；site_settings 5 key；lease/sweeper 基础设施就位
- **代码**: Worker（GitHub 端点 + sweeper cron */10）+ 前端（provider-aware makeImageUrl 唯一出口 + i18n skeleton）
- **积分**: 语义冻结未变（Single/ZIP/Package），0010 RPC 就位，前端接线属 Phase C
- **回滚路径**: image 行切回 `provider='supabase_storage'` + 原 storage_path（原件未删）；代码回滚 = 重新部署 V1.0 tag

## 7. 遗留与下一步

- GitHub 删除闭环已有 Worker 端点 + sweeper；**UI 面的 Collections / Credits 下载扣分 / 注册 Worker / Schedule** 属 Phase C（需新 Gate/计划）
- 演练仓库 `image-dryrun-sandbox` 验收完毕，可保留复用或删除
- 观察项: sweeper 首轮 cron 触发（无待收敛行则零动作）
