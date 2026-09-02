# 11 · Admin Workflow

## Create / Publish Asset 主工作流（单页向导式，连续完成）

```plaintext
/admin/assets/new
  Step 1 基础信息      Name* / Description / Slug(自动, 可改) / Tags(多选+即建)
  Step 2 封面          暂无图 → 先跳过 (cover_image_id=null, 用占位)
  Step 3 语言版本      勾选要创建的语言 (默认 en) → 逐语言上传图片
                       (直传 Storage images/{asset_id}/{lang}/ + 写 images 行)
  Step 4 整理          拖拽排序 (写 sort_order) / 删除图 / [Set as Cover] / 语言 Publish/Draft
  Step 5 Download Sources  Add Quark URL / Add Baidu URL / enabled 开关
  Step 6 预览          内嵌前台视角预览 (仅 published 内容 + draft 语言标灰)
  Step 7 [ Publish ]   assets.status=published → Audit: asset.published
```

- 保存草稿可在任意 Step 触发（status=draft），可反复回来编辑。
- Publish 前置校验：至少 1 个 published 语言且该语言 ≥1 张图，否则阻止并提示。

## 编辑已有 Asset（/admin/assets/:id）

- 左侧：语言面板 `English 12 images [published]` / `French 0 images [draft]`，操作：Add Language / Upload / Delete Image / Sort / Publish / To Draft。
- 右侧：基础信息 / Tags / Download Sources / Cover（从任意语言图片 [Set as Cover]）。
- 顶部动作条：`Preview`（新窗口开前台页）/ `Publish` / `Unpublish` / `Archive` / `Delete`（仅 admin，二次确认对话框，物理删除时列出影响范围）。

## 语言管理规则

- 语言行删除：仅允许删除 0 张图的版本；有图的需先清空（防误删）。
- Publish 语言不需要 Asset 已 published（允许提前备货），但前台可见需两者都 published。

## Tag 管理（/admin/tags）

- Create / Rename（同步更新 slug）/ Delete（确认对话框显示关联 Asset 数，删除级联清 asset_tags）。
- Asset 编辑页内 Tag 选择器：搜索现有 Tag + 快速新建。

## User 管理（/admin/users）

- 列表：Avatar / Name / Email / Role / Created / Status(disabled) / Actions。
- Change Role：`user ⇄ admin`，经 **Worker `/api/admin/users/:id/role`**（不直连），必须写 Audit `user.role_changed`（metadata: from/to/actor）。
- Disable：经 Worker，写 Audit；被禁用户下次会话校验失效。最后一名 admin 不可降级/禁用（服务端拒绝）。

## Storage（/admin/storage）

- 只读卡片：Used / Image Count / 按语言分布。数据源 `/api/admin/storage`。V1 无文件浏览器。

## Audit Logs（/admin/audit-logs）

- 表格：Time / Actor / Action / Target / Metadata(JSON 可展开)。
- 筛选：action 前缀（asset. / image. / tag. / download_source. / user.）、时间范围。
- 记录来源：DB 触发器（admin 直连写操作）+ Worker（user.role_changed / user.disabled）。

## Audit 覆盖清单（总纲 45/59 条）

| 操作 | 机制 | action |
| --- | --- | --- |
| Create/Update/Delete/Publish/Archive Asset | 触发器 | asset.created / updated / deleted / published / archived |
| Upload/Delete Image | 触发器(+Storage 删除由前端调) | image.uploaded / image.deleted |
| Tag Create/Rename/Delete | 触发器 | tag.created / tag.updated / tag.deleted |
| Download Source 变更 | 触发器 | download_source.updated |
| Change Role / Disable | Worker | user.role_changed / user.disabled |

## 权限自检（Admin UI 的每个数据请求都依赖 RLS，不重复造轮子）

Admin 页面使用与用户端同一个 Supabase Client，登录态切换后 RLS 自动放行/拒绝——
后台不做"写死 admin 才显示"的平行数据通道，UI 只负责引导。
