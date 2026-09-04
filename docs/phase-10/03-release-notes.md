# ACMERD Image Manager — V1.0 Release Notes

> 发布日期：2026-09-04 · Tag：`v1.0.0` · Gate：G0–G10 全 PASS
> 品牌名：ACMERD · 探知（Research · Discover · Create）

---

## 一、V1.0 是什么

管理员维护图片资产、注册用户浏览与下载的 **Digital Asset Library**。核心对象是 **Asset**（多语言版本承载），部署于 Cloudflare Workers（SPA + Hono Worker 一体）+ Supabase（Auth / PostgreSQL+RLS / Storage）。

线上：https://image.acmerd.com

## 二、V1.0 能力清单（Phase 0–9 交付）

| 领域 | 能力 |
| --- | --- |
| 资产 | Asset 创建/编辑/发布/归档/删除/封面；Publish 终守卫（需 ≥1 published 语言+图）；Cover 同资产守卫 |
| 多语言 | en/de/it/fr/es 五语言；Draft/Published 双层可见性（Asset+Language 双门控）；语言切换 `?lang` 校验回退 |
| 下载 | 单图（Worker 302 软门控 + 前端 blob 保原始文件名）；多选 ZIP（流式 store、≤30 图/≤100MB/并发 4/CRC32/无部分成功）；Package 网盘（Quark/Baidu，0 隐藏/1 直跳/2 选择器，与语言解耦） |
| 搜索 | `search_assets` ILIKE 子串 + 多标签 AND + 确定性排序；分页薄壳 + `search_assets_paged`（total + LIMIT/OFFSET，契约零破坏） |
| Admin Console | Dashboard 原子统计 / Assets / Users（角色与禁用，原子 RPC + advisory lock + last-admin 保护）/ Tags / Storage / Audit Logs |
| 安全 | 全表 RLS + 双层可见性视图；Worker 逐请求 JWT + role + disabled 门禁（403 `account_disabled`）；审计触发器 + 24 项 allowlist；Secret 仅 Worker/本地；URL 白名单守卫（https + pan.quark.cn/pan.baidu.com） |
| UX/性能 | 路由级代码分割（入口 −7.9% gzip）；分页（Home/Search/AdminAssets）；缩略图 transform（640 档）；全局 Toast / Skeleton / Lightbox（Esc + 焦点回归 + 滚动锁）；三视口响应式（含 Admin 宽表容器内滚动） |

## 三、V1.0 明确不包含（N/A 披露）

- **Reset Password is not included in V1.0.**（注册/登录/登出/会话均可用；密码找回未实现，Owner 裁决不临时补开发，留待 V1.x）
- 用户上传/编辑、付费、AI Tag、评论点赞、社交、复杂推荐、团队协作（总纲 §54 禁做清单）。

## 四、已知残余风险（Phase 8 安全评审冻结记录）

- **D5/5a**：public bucket + Worker 软门控为既定模型——已知 public URL 可 GET（Guest 浏览要求图片公开可读）。硬门控/私有化需独立 Change Proposal。
- Cloudflare API Token 缺 Workers Routes 读权限 → `wrangler deploy` 末尾 routes 同步告警（cosmetic，域名绑定不受影响；运维项）。
- OFFSET 分页在万级数据量前可接受，届时评估 keyset（记录为边界，不预建）。

## 五、发布物身份（Release Manifest）

| 项 | 值 |
| --- | --- |
| Release Commit | 见 tag `v1.0.0`（annotated，`git ls-remote refs/tags/v1.0.0` 为 Truth Source） |
| 前端 bundle | `index-DosBFCeX.js`（与生产 HTML 引用一致，重建 hash 同源） |
| Worker 版本 | `94cb46b3-c7b4-4c1c-878a-8e1aeb686d27` |
| DB 迁移 | 0001–0008 全部 applied（幂等全 skip） |
| 回归证据 | `docs/phase-10/02-regression-report.md`（100/100 PASS · 0 UNEXPECTED FAIL）+ `evidence-*.md` 三份 |

## 五A、发布后生产健康终检（2026-09-04，实测）

| 目标 | 结果 |
| --- | --- |
| /api/health | 200 ✅ |
| / （Home） | 200 ✅ |
| /search | 200 ✅ |
| /asset/ecosonique | 200 ✅ |
| /login | 200 ✅ |
| /admin 维度（admin session → /api/admin/users、/api/admin/stats） | 200 / 200 ✅ |
| 线上 bundle 身份 | `index-DosBFCeX.js` == Release Manifest ✅ |
| tag Truth Source | `ls-remote refs/tags/v1.0.0` → 解引用 commit = main HEAD ✅ |

## 六、V1.x Backlog 候选（非承诺）

密码找回（Reset Password）；Storage 对象缓存策略存量补齐（D5 可选项）；硬门控/私有桶评估（D5b/5c）；keyset 分页；Admin 移动端 Drawer 化导航。
