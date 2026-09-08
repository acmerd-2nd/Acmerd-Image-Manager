# V1.4 站点品牌可配置 — 收口报告

> **Gate 源**：`docs/v1.4/01-design-gate.md`（Owner 裁决落档）
> **实施 commit**：`860f288`（docs gate）→ `36b57c0`（0019 迁移）→ `456abab`（全文实现）
> **部署授权**：Owner AskUserQuestion「授权：迁移+部署+验证」（`授权：迁移+部署+验证 (Recommended)`）
> **部署日期**：2026-09-08
> **报告状态**：✅ **V1.4 Gate CLOSED**（生产已部署 + 生产验证 11/11 PASS）

---

## 1. TL;DR

V1.4 在既有 `site_settings` KV（0011）与 GitHub 图床通道（`worker/github.ts`）之上新增**可配置站点品牌**：导航文字 `brand_text`、浏览器标题 `brand_title`、Logo `brand_logo_path`（存于 GitHub 图床仓 `branding/logo.<ext>`）。零 schema 变更、零新权限、零新端点框架，复用既有 `requireAdmin` + `ghPutFile/ghDeleteFile/computeGitBlobSha`。生产已部署（Worker `b10be398-…`），0019 种子已应用，功能 e2e **11/11 PASS**，生产状态残留为默认。

---

## 2. Implemented（已落地）

### 2.1 数据层（0019 迁移）
- `supabase/migrations/0019_branding.sql`：对 `public.site_settings` 幂等种子 3 个 key：
  ```sql
  insert into public.site_settings (key, value) values
    ('brand_text',       '"ACMERD · 探知"'::jsonb),
    ('brand_title',      '"ACMERD · 探知"'::jsonb),
    ('brand_logo_path',  '""'::jsonb)
  on conflict (key) do nothing;
  ```
- **零 schema / 零 RLS / 零 Storage 变更**——完全复用 0011 的 `site_settings`（anon 可读、service_role 写）与 0014 的 GitHub 双模型通道。

### 2.2 Worker（`worker/index.ts`）
- `SETTING_KEYS` 扩 3 个 brand key（原 5 key → 8 key，allowlist 不变）。
- `STRING_KEYS` / `STRING_MAX`：PATCH 字符串校验入口新增 brand 三键（非空、≤ `STRING_MAX`、类型守卫）。
- `BRANDING_MAX_FILE_SIZE` 常量 + `readBrandLogoPath` / `writeBrandLogoPath` 助手。
- `POST /api/admin/branding/logo`（`requireAdmin`）：校验 `multipart/form-data` 单文件 → 扩展名白名单（`GITHUB_MIME_EXT`）+ MIME 一致性 + 体积；复用 `ghPutFile` 写入 `branding/logo.<ext>`（先 `computeGitBlobSha` 比对，避免重复写），回填 `brand_logo_path`。
- `DELETE /api/admin/branding/logo`（`requireAdmin`）：`ghDeleteFile` 删 GitHub 对象 + 清空 `brand_logo_path`；返回 `github_deleted` 标志。
- 认证：`authenticate()`（401/403/500 仅此三态）+ `requireAdmin`（151）+ `svc`（service_role 客户端）。
- Fallback：`app.all('*', ASSETS.fetch)`（2493）+ `app.notFound` JSON 404。

### 2.3 前端
- `src/features/settings/api.ts`：`SiteSettings` 接口 + `getSiteSettings`（含 3 brand 字段 + 兜底）。
- `src/lib/image-source.ts`：`brandLogoUrl(path)` → `string | undefined`（空串返回 undefined）。
- `src/features/admin/api.ts`：`PlatformSettings` + `getPlatformSettings` + `uploadBrandLogo` / `deleteBrandLogo`（FormData + Bearer）。
- `src/components/layout/AppShell.tsx`：`brandText` / `brandLogoPath` 状态；`document.title` 取自 `brand_title`；导航栏 `<img>` 或文字渲染。
- `src/routes/pages/admin/AdminDashboardPage.tsx`：`BrandingCard`（241–390）— 文字 ≤60 校验、Logo 上传/移除、即时预览、撤销确认。
- `src/i18n/zh.ts` / `en.ts`：`admin.brand.*` 键（411/409 行）同构，缺键即编译错。

---

## 3. Files（变更清单）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `supabase/migrations/0019_branding.sql` | 新增 | 幂等种子 brand_text/title/logo_path |
| `worker/index.ts` | 改 | +3 brand key、字符串校验、branding/logo 上传/删除双端点、助手 |
| `src/features/settings/api.ts` | 改 | SiteSettings + 3 brand 字段 |
| `src/lib/image-source.ts` | 改 | brandLogoUrl() |
| `src/features/admin/api.ts` | 改 | uploadBrandLogo/deleteBrandLogo |
| `src/components/layout/AppShell.tsx` | 改 | 导航品牌动态渲染 + document.title |
| `src/routes/pages/admin/AdminDashboardPage.tsx` | 改 | BrandingCard |
| `src/i18n/zh.ts` / `src/i18n/en.ts` | 改 | admin.brand.* 同构键 |
| `wrangler.toml` | 改 | `[assets]` 加 `run_worker_first = true`（**部署回归修复**，见 §6） |
| `scripts/v14-prod-verify.mjs` | 新增 | 生产功能验证脚本（可复跑，幂等还原） |
| `docs/v1.4/01-design-gate.md` | 既有 | Gate 裁决落档 |
| `docs/v1.4/02-implementation-report.md` | 本文件 | 收口报告 |
| `docs/v1.4/_evidence-deploy.log` / `_evidence-prod-verify.log` | 证据 | 部署 + 11/11 验证原始输出 |

---

## 4. Database（数据库）

- **0019 生产应用**：经 Supabase REST（service_role）对 `site_settings` 做 `on_conflict=key` upsert——幂等、不触碰既有行。
- **验证结果**（只读复查，2026-09-08）：
  ```
  site_settings:
    brand_text      = "ACMERD · 探知"   ✅ 默认
    brand_title     = "ACMERD · 探知"   ✅ 默认
    brand_logo_path = ""                ✅ 默认（无 Logo）
  ```
- **`schema_migrations` 记账**：REST 通道尝试写入 `schema_migrations` 被 service_role RLS 拒（403，该内部表 service_role 无 INSERT）——**仅记账缺失，数据已正确落地且已验证**。自愈：DNS 恢复后跑 `npm run db:migrate`，0019 幂等重放并补记。不影响运行。
- **零 schema 变更 / 零 RLS 变更 / 零 Storage 变更 / 零审计 allowlist 变更**。

---

## 5. Tests（测试）

### 5.1 本地门禁（部署前）
- `npm run typecheck`（前端 + Worker）：0 错误。
- `npm run build`：✅ `built in 2.36s`，`index-LDC4ezwS.js`。

### 5.2 生产功能验证（部署后）— `scripts/v14-prod-verify.mjs` → **11/11 PASS**
| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | admin 登录（GoTrue password grant） | ✅ token len 826 |
| 2 | PATCH /api/admin/settings brand_text+brand_title | ✅ 200 `{"ok":true}` |
| 3 | anon 直读 site_settings 反映 PATCH（brand_text） | ✅ got="V1.4TEST探知" |
| 4 | anon 直读反映 PATCH（brand_title） | ✅ got="V1.4TEST探知" |
| 5 | 还原 brand_text 为种子值 | ✅ got="ACMERD · 探知" |
| 6 | POST /api/admin/branding/logo（1x1 PNG） | ✅ 200 `{"ok":true,"path":"branding/logo.png"}` |
| 7 | 上传后 brand_logo_path 写入 | ✅ setting="branding/logo.png" |
| 8 | GitHub 图床仓含 branding/logo.png | ✅ HTTP 200 |
| 9 | DELETE /api/admin/branding/logo | ✅ 200 `{"ok":true,"github_deleted":true}` |
| 10 | 删除后 brand_logo_path 清空 | ✅ got="" |
| 11 | audit_logs settings.updated 命中（含 previous_path/github_deleted/brand_logo_path 元数据） | ✅ recent 元数据正确 |

脚本严格幂等：结束前把 brand_text/title 还原为种子、logo 还原为移除态——**生产最终状态 = 默认**（brand_text/title="ACMERD · 探知"，logo 空，GitHub `branding/` 空）。

---

## 6. Security（安全边界）

- **认证**：branding 双端点均 `requireAdmin`，无 token → 401 JSON（实测确认，非 SPA 回落）。
- **复用既有通道**：GitHub 写复用 `ghPutFile/ghDeleteFile`（与 0014 图床上传同源），无新密钥、无新权限面。
- **输入校验**：Logo 扩展名白名单 + MIME 一致性 + `BRANDING_MAX_FILE_SIZE`；品牌文字非空 + ≤`STRING_MAX`（PATCH 层类型守卫）。
- **审计**：品牌变更经既有 `site_settings` 审计动作 `settings.updated`（allowlist 既有项，无需扩容），元数据含 `previous_path`/`github_deleted`/`brand_logo_path`。
- **公开读**：`brand_text/title/logo_path` 经 0011 既有 anon 可读策略对外暴露（产品需要导航/标题公开），无新公开面。
- **Service Role Key**：仅 Worker Secret / 本地脚本，未进前端 bundle / Git / wrangler.toml（红线保持）。

### 6.1 部署回归修复（关键）
- **现象**：首轮 `wrangler deploy`（wrangler 4.128.0，由 `^4.4.0` 解析）后，全部 `/api/*` 返回 404 落到 SPA 回退（health 200→404、PATCH/GET settings 404、branding 401→404）。
- **根因**：wrangler 4.4 → 4.128 默认 `run_worker_first` 由 `true` 翻为 `false`（assets-first）。`wrangler.toml` 未显式声明 → 静态资产直出、Worker 对 `/api/*` 完全不接管。V1.3.1 部署时该值恰为默认 true，故历史无此问题。
- **修复**：`wrangler.toml [assets]` 显式加 `run_worker_first = true`，重部署。验证：无 token 访问 `/api/health`=200、`/api/admin/settings` 无 token=401 JSON（Worker 已接管）。**此修复为独立 scoped commit，与功能代码分离**。

---

## 7. Evidence（证据）

- 部署原始输出：`docs/v1.4/_evidence-deploy.log`（wrangler 4.128.0；"Uploaded acmerd-image-manager"；routes 10000 报错 = cosmetic）
- 生产验证原始输出：`docs/v1.4/_evidence-prod-verify.log`（11/11 PASS 逐行）
- 部署版本核验：`wrangler deployments list` → 当前 100% 流量版本 **`b10be398-d2c0-4e9a-8ad4-90b444a412b8`**（2026-09-08T07:06:32Z）
- 只读 DB 复查（见 §4）：3 brand 行 = 默认

---

## 8. Gate Status

| 维度 | 状态 |
| --- | --- |
| Design Gate（`01-design-gate.md`） | ✅ Owner 全项裁决 |
| 本地 typecheck / build | ✅ 0 错 / 成功 |
| 0019 生产应用 | ✅ 3 brand 行已落地（幂等），默认态 |
| Worker 部署 | ✅ ver `b10be398-…`（含 run_worker_first 修复） |
| 生产功能验证 | ✅ 11/11 PASS，残留 = 默认 |
| 安全边界 | ✅ 复用既有通道 + requireAdmin + 审计 + 输入校验 |
| **Gate 结论** | ✅ **V1.4 CLOSED** |

**回滚锚点**：`wrangler rollback` 回到 V1.4 前一部署 `8d214ddf-9c54-422a-a7ac-3e899d785aed`（代码+assets 整体回退，无需动库；品牌仅 KV 数据，回退后前端回退到旧硬编码"ACMERD · 探知"，行为一致）。

**未含项 / 开口**：
- 本 Agent 收尾**未 push**（Owner 授权为「迁移+部署+验证」，未含 push）。push 待 Owner 用可靠模式（HANDOVER §三#2）确认。
- `schema_migrations` 0019 记账待 DNS 恢复后 `db:migrate` 自愈（数据已正确，不影响运行）。
- 本地规划文档 + `.workbuddy/` 按惯例不推公开仓库。
