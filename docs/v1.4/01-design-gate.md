# V1.4 Design Gate — 站点品牌可配置（Site Branding）

> 状态：**Gate 已裁决（Owner 2026-09-08 晚 chat 裁决完毕），代码未动 → 本文件为裁决落档 + 实施前基线。**
> 交接来源：`交接-站点品牌可配置.md`（项目根目录）。
> 生产基线：ver `ad5dfa69`，迁移 0001–0018，audit allowlist 44，GitHub 图仓库 `acmerd-2nd/-Photo-Acmerd-Image-Manager`（public）。

## 1. Goal
允许管理员在后台自由配置「站点品牌」：
- **导航品牌文字 + 浏览器标签页标题**（同一字段 `brand_text` 控导航文字，`brand_title` 控 `document.title`，种子同值 `'ACMERD · 探知'`）
- **站点 Logo**：存到现有 GitHub 图仓库 `branding/logo.<ext>`，URL 走 `src/lib/image-source.ts` 统一出口；支持移除（回落纯文字）

## 2. Scope
纳入：
- 3 个 `site_settings` key（零 schema 迁移，仅幂等种子）
- Worker：`SETTING_KEYS` 扩展 + 字符串校验 + 2 个新端点（POST/DELETE `/api/admin/branding/logo`，`requireAdmin`）
- 前端：Admin 后台「站点品牌」卡片（文字输入 + Logo 上传/预览/移除 + 推荐比例提示）、导航与标题动态渲染、i18n 双语言
- 审计复用 `settings.updated`（allowlist 44 已含，无需扩）

Out of Scope（本 Gate 不碰）：
- SVG 支持（安全面排除）
- 多套主题/深色 Logo/ favicon 上传（如需后续 Change Proposal）
- 登录页品牌（LoginPage 当前无品牌硬编码，无需改动）

## 3. Owner 裁决（chat 原文，勿重问）
- **文字范围** = 导航文字 + 浏览器标题：后台改一个字段控制导航品牌文字，另一个控制 `document.title`
- **Logo 存储** = GitHub 图仓库，复用 `ghPutFile`，写 `branding/logo.<ext>`，URL 经 `src/lib/image-source.ts`
- **既定约束**（上一 Agent 方案，Owner 未反对）：JPEG/PNG/WebP ≤1MB；SVG 排除；支持移除（回落文字）；上传控件旁固定推荐比例文案（横版 2:1~6:1、高 ≥40px、透明底 PNG 最佳、≤1MB）

## 4. 数据（DB）
- `site_settings` 为 KV 表（0011 已建，anon 读 / service_role 写 grants 已就位）
- 新增 3 key **零 schema 迁移**：`0019_branding.sql` 仅幂等种子
  - `brand_text` jsonb string `'ACMERD · 探知'`
  - `brand_title` jsonb string `'ACMERD · 探知'`
  - `brand_logo_path` jsonb string `''`（无 logo）
- 不覆盖生产已调整值（`on conflict do nothing`）

## 5. Worker（`worker/index.ts` + `worker/github.ts`）
- `SETTING_KEYS` 扩 `brand_text` / `brand_title` / `brand_logo_path`；新增 `STRING_KEYS` 校验（typeof string、trim 非空——`brand_logo_path` 允许空串、≤200 字符；`brand_text`/`brand_title` ≤60）
- settings PATCH 分支支持 string 类型（现有 boolean/number 之外）
- 新端点 `POST /api/admin/branding/logo`：`requireAdmin` → multipart `file` → MIME ∈ {image/jpeg,image/png,image/webp}、size ≤1MB → `ghConfig()` → `branding/logo.{ext}` → `computeGitBlobSha` → `ghPutFile`（旧扩展名不同先 `ghDeleteFile`）→ service_role 写 `brand_logo_path` → 审计 `settings.updated`
- 新端点 `DELETE /api/admin/branding/logo`：`requireAdmin` → best-effort `ghDeleteFile`（失败仍清 setting 并在 metadata 注记）→ 清空 `brand_logo_path` → 审计

## 6. 前端
- `settings/api.ts`：`SiteSettings` 加 `brand_text` / `brand_title` / `brand_logo_path`（map 兜底）
- `image-source.ts`：export `brandLogoUrl(path)` = `path ? githubRawUrl(path) : null`
- `AppShell.tsx`：读 settings → 品牌区 `brand_logo_path` 非空渲染 `<img>`，否则渲染 `brand_text`；同 effect 设 `document.title = brand_title`
- `admin/api.ts`：`uploadBrandLogo(file)` / `deleteBrandLogo()`
- `AdminDashboardPage.tsx`：新「站点品牌」卡片（文字输入 ≤60 + 保存；Logo 上传 input + 预览 + 移除 + 推荐比例提示 + Toast）
- i18n zh/en：`admin.brand.*`（两语言同构；en 为 `typeof zh`，漏 key 编译报错）

## 7. 安全边界（红线圈）
- Service Role Key 仅 Worker/本地脚本；RLS 唯一事实源（settings anon 只读、写仅 Worker service_role——0011 已就位，不动）
- 不绕过 settings key 白名单；新端点必须 `requireAdmin`
- URL 出口只允许 `image-source.ts`
- 未提供证据不宣布 PASS；**生产部署 / 生产库变更需 Owner 单独授权**

## 8. 验收（无证据不 PASS）
- 本地 typecheck（worker + frontend）+ build 绿
- 部署后判别器：curl 无 token 调新端点应 401
- 生产验证（Owner 授权后）：admin PATCH `brand_text` → 导航+标题变化；传 PNG logo → raw URL 200 + 前台显示 → DELETE 回落文字；GitHub 仓出现 `branding/logo.png`；审计有 `settings.updated`
- 残留检查：测试 logo 删除后 GitHub `branding/` 目录应空

## 9. 实施记录（回填区，Gate CLOSED 后填）
- 待执行：0019 迁移 → worker 两端点 → 前端 8 项 → typecheck/build → **STOP 等 Owner 授权部署**
