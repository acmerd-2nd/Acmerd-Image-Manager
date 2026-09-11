# V1.7.0 合集封面本地上传 — 实施与验收

版本：v1.7.0（合集封面支持从本地上传一张独立图片）
日期：2026-09-11
生产：Worker ver `05b2ef9c`（100%）；前端 chunk `index-Cb-8aEc3.js`；迁移 `0024` 已应用（schema_migrations=24）
远端：`main = b9680b0`（+ 收口提交）

## 需求
Owner：合集封面此前只能选本合集内资产的图；希望能从本地上传一张新图作封面。

## 决策（AskUserQuestion）
- 并存互斥、上传优先：`cover_source_path`（本地上传）与 `cover_image_id`（选合集内资产图）二选一，设一个清另一个，上传优先展示。
- 仅合集（资产封面不动）。
- 格式 jpeg/png/webp，≤5MB。
- 单阶段实现→验证→提交→STOP→授权部署。

## 设计（镜像站点 Logo，零改 membership 触发器）
根因：`cover_image_id` 被 `0009 guard_collection_cover` 强制归属本合集资产，且 `images.asset_language_id NOT NULL` 使独立图无法作为 images 行。
方案：新增独立列 `collections.cover_source_path`，图片字节进 GitHub 图仓库 `collections/{id}/cover.{ext}`（不进 images 表），前台经 `githubRawUrl` 公开出图。写该列不触发只校验 `cover_image_id` 的守卫。

## 改动
- **0024**：`add column cover_source_path text` + 重建 `published_collections` 视图（末尾追加该列，列序保持 0015 原样 +1）。
- **Worker**：`POST/DELETE /api/admin/collections/:id/cover`（requireAdmin + MIME 白名单 + ≤5MB + `ghPutFile/ghDeleteFile` 幂等替换、无租约同 Logo）；PATCH 选中资产图时互斥清 `cover_source_path`；删合集 best-effort 清 GitHub 封面。审计复用 `collection.updated`。
- **前端**：`collectionCoverUrl` 出口；`CollectionRow/PublishedCollectionRow` 加字段；`uploadCollectionCover/deleteCollectionCover`；`AdminCollectionsPage` 封面卡改「上传本地封面 / 从合集内选择 / 移除」三态 + 来源徽标，发布门槛放行上传封面；`CollectionCard` 上传优先渲染。
- **i18n** zh/en `admin.collections.*` 新增上传文案，修正 `coverPickHint/coverNone/coverEmpty`。

## 验收
- app + worker typecheck、`vite build` 绿。
- `scripts/v17-cover-guard-smoke.mjs`：端点鉴权/非法 id/非图片 MIME/超 5MB/合集不存在/DELETE 无鉴权/DELETE 不存在 → **7/7**（均在任何 GitHub/DB 写入前返回）。
- `scripts/v17-cover-live-verify.mjs`（生产、隔离 draft 合集、finally 零残留）→ **17/17**：上传落 `cover_source_path` 且清 `cover_image_id` + GitHub 对象公开可读；换扩展名上传旧对象被删；移除删对象 + 清列；删合集清理封面 GitHub 对象；anon `published_collections` 视图含 `cover_source_path` 键。存在性/删除一律以 GitHub Contents API（源真值）判定。

## 备注 / 遗留
1. **raw.githubusercontent 缓存**：删除封面对象后，`raw.githubusercontent.com` 边缘可能仍短暂返回旧图（分钟级）；DB 与 GitHub 源已即时更新。换新封面走新文件名，前台不受影响；「移除」后旧 URL 的短暂残留无功能影响。
2. 后台封面卡与前台渲染的肉眼排版建议 Owner 在真实合集上各点一次确认（后端写入/删除/清理已由 17/17 证明）。
3. 资产封面暂未纳入本地上传（按决策仅合集）。
