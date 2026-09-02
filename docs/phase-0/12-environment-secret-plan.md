# 12 · Environment / Secret Plan

## 变量清单

| 变量 | 位置 | 性质 | 用途 |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Worker (vars) | 公开 | Worker 调 Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | Worker (vars) | 公开 | Worker 侧需转发鉴权时使用 |
| `SUPABASE_SERVICE_ROLE_KEY` | **Worker Secret** | 🔴 机密 | ZIP 打包 / 统计 / 角色管理 / 审计补写 |
| `CLOUDFLARE_ACCOUNT_ID` | 本地 `.env` / CI Secret | 🔴 机密 | wrangler deploy |
| `CLOUDFLARE_API_TOKEN` | 本地 `.env` / CI Secret | 🔴 机密 | wrangler deploy |
| `GITHUB_TOKEN` | 本地 `.env` | 🔴 机密 | push 代码 |
| `DATABASE_URL` | 本地 `.env` | 🔴 机密 | supabase migration 直连 |
| `VITE_SUPABASE_URL` | Vite 构建注入 | 公开 | 前端 Supabase Client |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite 构建注入 | 公开 | 前端 Supabase Client |

## 存放位置与流转

```plaintext
本地开发
  E:\【项目】0002.Acmerd-Image-Manager\.env          ← 全部变量真实值（.gitignore 已排除）
  .env.example                                       ← 模板占位，可提交
  worker/.dev.vars                                   ← wrangler dev 本地 secret 模拟（.gitignore 已排除）

部署（Cloudflare）
  wrangler.toml  [vars]        ← 仅公开变量 (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY)
  wrangler secret put SUPABASE_SERVICE_ROLE_KEY   ← 机密只走 Secret，永不进 toml/git

前端构建
  Vite 只注入 VITE_ 前缀变量 → 只有 URL + Publishable Key 进 bundle
  CI/本地构建都读 .env；禁止任何构建脚本读取 SERVICE_ROLE_KEY
```

## 绝对红线（复述总纲 50 条）

1. `SUPABASE_SERVICE_ROLE_KEY` / `DATABASE_URL` / `CLOUDFLARE_*` / `GITHUB_TOKEN` **永远不出现**在：前端 bundle、Git 历史、wrangler.toml、日志输出。
2. 前端仅有 Publishable Key，安全性完全依赖 RLS + Storage Policy。
3. 若任何机密意外泄露：立即在对应平台轮换（Supabase → API keys rotate；CF → roll token；GitHub → revoke PAT），并检查 Git 历史。

## 当前状态

- 本地 `.env` 已写入全部真实值并完成连通性验证（2026-09-02）。
- Worker Secret 将在 Phase 1 部署时用 `wrangler secret put` 注入。
- 首个 Admin 账号：建议 Owner 用目标邮箱先注册，然后执行一次性 SQL 提权（migration 附带 `assign_first_admin` 函数，**不把邮箱硬编码进代码库**）。
