# V1.4.2 设计注记 — 资产详情页面包屑（快捷返回上层）

> 日期：2026-09-09 · 触发：Owner 指示「合集已经有了面包屑导航，但是资产还是没有快捷返回上层的按钮」
> 性质：小型 UX 增强（前端 + 视图增列），无 RLS/Worker 写路径变更。

## 需求与方案

资产详情页在资产属于某合集（含多级父链）时，于标题上方渲染面包屑：**探索 / 合集根 … / 当前合集 / 资产名**——中间合集全部可点击直达；无合集或链断裂时不渲染（回落全局站点面包屑「探索 / 资产名」）。

## 裁决点（本注记即终稿，Owner 指示视为批准）

| # | 决策 | 说明 |
| --- | --- | --- |
| D1 | `published_assets` 视图增列 `collection_id`（0021，create or replace 仅增列） | where/join/grants/security_invoker 原样 → 公开可见性零漂移；`select('*')` 前端自动带出 |
| D2 | 链数据取自 `published_collections`（anon 可读） | 全链 published 才公开的既有收敛天然生效：资产公开但其某级合集未发布 → 链查询返回空 → 不渲染面包屑（不泄露未发布合集名） |
| D3 | 页内面包屑（与 CollectionDetailPage 同款样式），不改全局 Breadcrumbs 组件的静态 trail | 全局组件是路径推导式，动态合集链以页内渲染承载（先例一致）；全局仍显示「探索 / 资产名」（leafName 既有机制） |
| D4 | 复用 `getPublishedBreadcrumb`，新增 `getPublishedBreadcrumbById` | 合集不在 published_collections（draft/链断）→ 返回 `[]` |

## 改动面

- **0021_asset_breadcrumb.sql**：视图增列 + grant 幂等兜底（唯一迁移，KV/表零变更）
- `src/types/database.ts`：`PublishedAssetRow.collection_id`
- `src/features/collections/api.ts`：`getPublishedBreadcrumbById`
- `src/routes/pages/AssetDetailPage.tsx`：链 state/effect + 标题上方面包屑渲染（探索 / 合集链 / 资产名，末级不可点）

## 验证计划

- 隔离库冒烟 `scripts/v142-asset-breadcrumb-smoke.mjs`：视图列/grants、guest 可见性零漂移（draft 不可见）、collection_id 取值、链断裂语义、anon 禁写
- typecheck + build；生产部署（单独授权）后：UI 走查资产页面包屑 + 未发布链不渲染
