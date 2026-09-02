# 01 · Architecture Diagram

ACMERD Image Manager — Phase 0 Architecture Baseline

## 系统总体架构

```plaintext
                        Internet
                           │
                           ▼
                 image.acmerd.com (Cloudflare)
                           │
              ┌────────────┴─────────────┐
              │   Cloudflare Worker      │
              │   (Hono, 单一 Worker)     │
              └────────────┬─────────────┘
        ┌──────────────────┼───────────────────┐
        │                  │                   │
   Static Assets        /api/* (BFF)        Admin API
   (React SPA)              │                   │
        │          ┌────────┴────────┐          │
        │          │ ZIP Streaming   │          │
        │          │ Download Auth   │          │
        │          │ User Role Mgmt  │          │
        │          │ Stats / Storage │          │
        │          └────────┬────────┘          │
        │                  │                   │
        └──────────────────┼───────────────────┘
                           │
                     Supabase (ctddbmadywtdufazhwiq)
              ┌────────────┼────────────────┐
              │            │                │
            Auth       PostgreSQL        Storage
        (GoTrue v2)    (RLS 全程防护)     bucket: images
              │            │                │
          Identity     Metadata          Image Files
```

## 组件职责划分（关键决策）

| 组件 | 职责 | 说明 |
| --- | --- | --- |
| React SPA | 全部页面 UI、直接读 Supabase（受 RLS 保护） | 浏览/搜索/详情等读操作**不走自建 API**，直接 Supabase Client 查询，RLS 是唯一读权限边界 |
| Cloudflare Worker | 1) 托管 SPA 静态资源 2) `/api/*` BFF | 只承载**必须服务端参与**的能力，不做通用 CRUD 转发层 |
| Worker `/api/downloads/*` | 单图下载鉴权、多选 ZIP 生成 | 用 Service Role 读 Storage，流式打包 |
| Worker `/api/admin/*` | 用户角色管理、Dashboard 统计、Storage 用量 | 角色变更写 `user_roles` 必须走 service role + Audit |
| Supabase Auth | 注册/登录/Session/JWT | 前端直连 GoTrue |
| Supabase PostgreSQL | 全部业务数据 + RLS + Audit 触发器 | Admin 的常规 CRUD（Asset/Image/Tag/DownloadSource）由前端用 anon key 直连，RLS 放行 admin、拒绝其他 |
| Supabase Storage | 图片文件，public bucket `images` | 读公开；写仅 admin（Storage Policy） |

## 为什么"读走 RLS 直连、写分两路"

- **读**：Guest 也要看图，静态内容读多写少，直连 Supabase + RLS 最简单、延迟最低、无自建代理成本。
- **Admin 常规写**：RLS 已经能识别 admin，前端直连即可，不需要经 Worker 中转（避免无意义的重复鉴权代码）。
- **必须经 Worker 的写**：凡是"操作对象本身要求 service role 才能改"的（如改别人角色：`user_roles` 的写权限只给 service role，防止 admin 互相提权失误留下无审计通道），以及 ZIP 生成、统计聚合。

## 请求流示例

```plaintext
[浏览]  Browser ──(anon key + RLS)──▶ Supabase REST ──▶ Asset Cards
[登录]  Browser ──▶ Supabase Auth ──▶ JWT 存本地 ──▶ 刷新角色缓存
[单图下载] Browser ──GET /api/downloads/image/:id (Bearer JWT)──▶ Worker 校验 USER/ADMIN ──▶ 302 Storage URL
[多选 ZIP] Browser ──POST /api/downloads/zip (Bearer JWT)──▶ Worker 限额校验 ──▶ 流式 ZIP
[Admin 改角色] Admin Browser ──POST /api/admin/users/:id/role──▶ Worker 校验 admin ──▶ service role 更新 + audit_logs
[Admin 建 Asset] Admin Browser ──(admin JWT + RLS)──▶ Supabase REST ──▶ 触发器写 audit_logs
```

## 部署链路

```plaintext
git push (main)
   ↓
[当前阶段] 本地 wrangler deploy（Owner 手动触发）
   ↓
Cloudflare Worker 绑定自定义域 image.acmerd.com
   ↓
supabase/migrations/ 经 Supabase CLI 或 Dashboard 执行
```

> Phase 0 结论：单 Worker（静态资源 + API）方案，不拆分前后端服务；不引入 CI/CD 流水线（Phase 1 可选加 GitHub Actions）。
