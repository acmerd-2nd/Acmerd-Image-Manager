# V1.2 Design Gate — 多层 Folder · Schedule 编排 · 密码找回 · R1 CDN

- **日期**: 2026-09-07
- **状态**: 🔴 **PENDING OWNER 裁决（D1–D12）——批准前零代码、零 schema、零生产触碰**
- **范围来源**: Owner 2026-09-07 从计划表延后项中全选四项；V1.1（Phase A/B/C）已 CLOSED 并生产运行（ver `71278568`）
- **前置**: V1.1 全部冻结不变量继续有效；`/asset/:slug`、`/collection/:slug` URL 语义**永不改变**（总纲 §73 风险三，继续冻结）

---

## §0 现状事实（均已核对）

- `collections`（0009）：`id/name/slug(unique)/description/cover_image_id/status(asset_status)/sort_order/created_by/ts`；无层级概念。
- `published_collections` 视图（0012，security_invoker）：published + `asset_count`（直接子资产数）。
- RLS（0012）：anon 读 published、admin 写；审计 ins/del/status_change。
- `site_settings`（0011）：5 key KV（jsonb），anon 可读。
- Worker admin collections CRUD 已在（PC-2）；Schedule 页 = Coming Soon 占位（`schedule_navigation_enabled` 开关在位）。
- `image-source.ts`：`VITE_GITHUB_IMAGE_CDN_BASE` 切换口**已预留**（设置即整体切换，零数据迁移）；「无 Worker 图片代理」= 冻结不变量。
- GoTrue 原生支持密码恢复流（`resetPasswordForEmail` + recovery session + `updateUser({password})`）；邮箱确认当前为**关闭**态。

---

## §1 A —— 多层 Folder（Collection 树，总纲需求 3 完整形态）

**模型**：`collections.parent_id` 自引用 FK；同层沿用现有 `sort_order` 排序。

**不变量保持**：URL 全平（`/collection/:slug` 直接按全局唯一 slug 定位，与层级无关）——外部链接/收藏零破坏；RLS 政策本身不变（新增列不改变授权面）。

**视图升级**：`published_collections` 增加 `parent_id`；公开可见性语义见 D2；首页只列**根** Collection。

### 裁决点
| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **D1** | 嵌套深度 | **任意深度 + 硬上限 5 层**：同一触发器内先做**防环**（沿 parent 链向上走，遇自身或超限即拒，复用 0003 cover-guard 范式）再做深度校验。备选：固定 2 层（实现最简，但"真正的文件夹层级"名不副实） |
| **D2** | 子级公开可见性 | **全链 published 才公开**（镜像 V1.0「Asset+Language 双层可见性」哲学）：子 Collection published 但任一祖先 draft → 公域不可见（首页/父页均不出现），直链 slug 404。视图内用递归 CTE 判祖先链。备选：各级独立可见（语义散，不推荐） |
| **D3** | 删除父级时子级 | **RESTRICT**：有子级不允许删（报 `COLLECTION_HAS_CHILDREN`，Admin 须先移动/删除子级），与「cover 同资产守卫」同一哲学——绝不静默级联/提升。备选：SET NULL 升为根（隐式搬家，不推荐） |
| **D4** | `asset_count` 口径 | **只数直接子资产**（descendant 不折算进父级计数，UI 用子卡片表达层级）——视图零递归、成本最低。备选：递归累计（视图变重） |
| **D5** | Admin 移动语义 | `PATCH /api/admin/collections/:id` 增加 `parentId`（设为根 = null）：服务端校验存在性/非自身/防环/深度上限，落 `collection.updated` 审计（metadata 含 from→to）；前端 AdminCollections 树形缩进展示 + 建改选父级 |

**迁移**：0015（parent_id + 防环/深度触发器 + 视图重建 + 幂等）；**前端**：首页根级、详情页面包屑（祖先链）+ 子 Collection 卡片区 + 资产网格；**i18n**：`collection.*` 扩展。

---

## §2 B —— Schedule 内容编排（总纲需求 4 完整形态）

**模型**：新表 `schedule_items`（不复用 site_settings KV——多项、排序、独立可见性，表是唯一正解）：

```
schedule_items(id, title, description, event_date date,
               status asset_status default 'draft', sort_order int,
               created_by, created_at, updated_at)
```

**裁决点**
| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **D6** | 字段最小集 | v1 只做 `title / event_date / description / status / sort_order`（不加 URL/封面/时间段——避免过度设计，未来需要走 Change Proposal） |
| **D7** | 公开语义 | 镜像 collections：`published_schedule_items` 视图（security_invoker）只吐 published，按 `event_date asc, sort_order asc` 排序；RLS 同 0012 三政策；**与导航开关解耦**（总纲 §23 既定：开关只控导航显隐，页面有内容可直访） |
| **D8** | Admin 面 | 新增 `GET/POST/PATCH/DELETE /api/admin/schedule-items`（原子 mutation + 审计 `schedule.item_created/updated/deleted`，**0016 同文件扩 allowlist**）；前端新增 AdminSchedulePage（列表 + 创建/编辑/删除 + 上下移）+ 路由 + 侧栏项；公开 SchedulePage 渲染真实条目（空态回 Coming Soon 文案） |

**迁移**：0016（表 + RLS + 视图 + 审计触发器 + allowlist 扩展，全幂等）。

---

## §3 C —— 密码找回（V1.0 backlog 第 1 项）

**方案**：**GoTrue 原生恢复流，纯前端 + Supabase 配置，Worker 零新端点**：

```
/login「忘记密码？」 → /reset-password（输入邮箱）
  → supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/reset-password/confirm })
  → 用户邮件点链接（recovery session 建立）
  → /reset-password/confirm（新密码 + 确认）→ supabase.auth.updateUser({ password }) → 回 /login
```

### 裁决点
| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **D9** | 链路归属 | 客户端直连 GoTrue 原生流（邮箱所有权即授权边界，与登录同级；Worker 加端点纯属多余攻击面）。**备选**：Worker 代理（不推荐） |
| **D10** | SMTP / 重定向配置（**生产配置项，需 Owner 在 Supabase Dashboard 操作或明确授权 Agent 操作口径**） | ①启用自定义 SMTP（生产级送达率）或先用 Supabase 内置 mailer（**免费档限速 ~2 封/小时**，仅够试用）；②`Site URL` 确认 = `https://image.acmerd.com`；③`Additional Redirect URLs` 加 `https://image.acmerd.com/reset-password/confirm`。**代码侧防线**：`redirectTo` 只接受本文件常量白名单（同源），绝不拼接用户输入 |
| **D11** | 审计 | **不落 audit_logs**（恢复流全程不经 Worker，client grants 本就无 audit_logs 写权限；GoTrue 自带日志）。接受此盲区并留档 |

**新增**：`/reset-password`、`/reset-password/confirm` 两页（守卫：confirm 页无 recovery session → 重定向回请求页）+ 登录页链接 + i18n（zh/en 同构）。**零 schema**。

---

## §4 D —— R1 CDN 切换（raw 大陆可访问性）

**约束**：「无 Worker 图片代理」是冻结不变量 → 候选只有**外部 CDN（jsDelivr）**或维持现状。切换口已就绪（`VITE_GITHUB_IMAGE_CDN_BASE` 构建期变量，设了即全量切换，零代码零迁移）。

### 裁决点
| # | 问题 | Agent 建议 |
| --- | --- | --- |
| **D12** | CDN 策略 | **v1.2 只做「实测评估 + 决策留档」，不直接默认切换**：用 jsDelivr `@main` 分支引用实测三件事——①仓库首字符为 `-`（`-Photo-Acmerd-Image-Manager`）在 `cdn.jsdelivr.net/gh/…` 路径下的兼容性；②大陆可达性；③**删除/更新后的 stale 窗口**（分支引用缓存 ~12h–7d，已删图在过期前仍可访问；路径含 uuid 不可枚举，风险低但须书面接受）。实测结论交 Owner 拍板默认出口；`@commit-sha` 永久缓存方案（删除内容永续可访 + 需 commit sha 映射）**明确排除**。后续如启用，可将 jsDelivr purge API 接入 github-delete 流程（另立 Change Proposal） |

---

## §5 实施顺序与纪律（获批准后）

1. **A 多层 Folder**（0015 → 隔离库冒烟 → Worker → 前端 → 沙箱）——最重，先行；
2. **B Schedule**（0016 → Worker → 前端）；
3. **C 密码找回**（纯前端 + Owner 完成 D10 生产配置后线上验证）；
4. **D CDN**（实测评估报告 → Owner 终裁）。

每步沿用 V1.1 节奏：migration → 隔离库冒烟（若本机不可行则如实标注）→ 沙箱/线上证据 → 结束报告 → commit；**生产部署仍单独授权**。红线全部继承（凭据不入 Git/chat、RLS 唯一真源、`makeImageUrl` 唯一出口、URL 语义不变、Storage 原件零触碰）。

## §6 非目标

Schedule 活动报名/日历订阅；Folder 权限分级；多管理员协作流；邮件模板定制；图片代理（冻结不变量）；`@commit-sha` CDN。

## §7 Owner 裁决表（待填）

| D1 嵌套深度 | D2 可见性 | D3 删父语义 | D4 计数 | D5 移动 | D6 字段 | D7 公开 | D8 Admin | D9 恢复链路 | D10 SMTP/配置 | D11 审计盲区 | D12 CDN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |
