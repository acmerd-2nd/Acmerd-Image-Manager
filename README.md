# ACMERD Image Manager

> **ACMERD · 探知** — Research · Discover · Create
>
> 以 Asset 为核心的 Digital Asset Library：管理员维护图片资产，普通用户浏览与下载，支持 EN/DE/IT/FR/ES 多语言图片版本。

`https://image.acmerd.com`

## 架构

```plaintext
GitHub
  ↓
Cloudflare Worker (React SPA + /api BFF)
  ↓
Supabase
  ├── Auth
  ├── PostgreSQL (RLS 全程防护)
  └── Storage (bucket: images)
```

## 技术栈

React 18 · TypeScript · Vite · Tailwind CSS · shadcn 风格组件 · React Router · Hono (Cloudflare Workers) · Supabase JS

## 目录结构

```plaintext
src/                  React SPA（features/ 按业务域组织）
worker/               Cloudflare Worker（Hono，/api/*）
supabase/migrations/  数据库 migration（唯一结构变更入口）
docs/phase-0/         架构基线设计文档（ERD / RLS / API / 流程）
scripts/              db migration 执行器
```

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 本地前端开发 (Vite, :5173)
npm run dev:worker   # 本地 Worker 开发 (wrangler, :8787)
npm run build        # 构建前端到 dist/
npm run typecheck    # 前端 + Worker 类型检查
npm run db:migrate   # 执行未应用的 migration（读 .env 的 DATABASE_URL）
npm run deploy       # 构建 + 部署到 Cloudflare (image.acmerd.com)
```

## 环境变量

复制 `.env.example` 为 `.env` 并填入真实值。`.env` / `worker/.dev.vars` 已被 `.gitignore` 排除，**绝不提交**。

- 前端仅注入 `VITE_` 前缀的公开变量（Supabase URL + Publishable Key）
- `SUPABASE_SERVICE_ROLE_KEY` 仅存在于 Cloudflare Worker Secret，禁止进前端与 Git
- 数据库结构变更只通过 `supabase/migrations/`，禁止在 Dashboard 手工改生产结构

## 路线图

分 10 个 Phase 实施（详见 `docs/` 与项目计划）：

Phase 0 Architecture ✅ → **Phase 1 Foundation ✅** → Phase 2 Auth → Phase 3 Asset Core → Phase 4 Multi-language → Phase 5 Download → Phase 6 Search & Tags → Phase 7 Admin Console → Phase 8 Security → Phase 9 UX & Performance → Phase 10 Release
