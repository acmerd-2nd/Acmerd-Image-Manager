# 05 · RLS Policy Plan

所有业务表 `enable row level security`。策略方向：**anon/authenticated 默认无权限，显式授予**。

## 通用谓词

```sql
-- 已发布且可见（含语言与资产双层检查）
-- assets:        status = 'published'
-- asset_languages: 存在且其 asset published
-- images:        其 asset_language published 且其 asset published
```

## profiles

| 操作 | 策略 |
| --- | --- |
| SELECT | `id = auth.uid()`（看自己）或 `is_admin()`（看全部） |
| UPDATE | `id = auth.uid()`（仅 display_name / avatar_url，用列级触发器或 before 约束防止改 disabled） |
| INSERT / DELETE | 无客户端策略（注册触发器 service role 完成；删除走 auth admin） |
| disabled 列 | 仅 Worker Admin API（service role）可改 |

## user_roles

| 操作 | 策略 |
| --- | --- |
| SELECT | `user_id = auth.uid()`（前端据此刻画 UI/Route Guard） |
| INSERT / UPDATE / DELETE | **无客户端策略** —— 即使 ADMIN 也不能从浏览器改角色；改角色必须走 Worker `/api/admin/users/:id/role`（service role + Audit），防止提权操作绕过审计 |

## assets

```sql
-- SELECT
status = 'published'                  -- anon / authenticated
OR is_admin()                         -- admin 看全部（含 draft/archived）
-- INSERT / UPDATE / DELETE
is_admin()                            -- 仅 admin
```

## asset_languages

```sql
-- SELECT
exists (select 1 from assets a
        where a.id = asset_id and a.status='published')
and status = 'published'              -- anon / authenticated
or is_admin()                         -- admin 看全部
-- INSERT / UPDATE / DELETE
is_admin()
```

## images

```sql
-- SELECT
exists (select 1 from asset_languages l join assets a on a.id = l.asset_id
        where l.id = asset_language_id
          and l.status='published' and a.status='published')
or is_admin()
-- INSERT / UPDATE / DELETE
is_admin()
```

## tags / asset_tags

```sql
-- tags: SELECT 全体可见（anon 也要能显示 Tag 云）
-- tags: INSERT / UPDATE / DELETE → is_admin()
-- asset_tags: SELECT 全体可见（有 joined 约束：仅 published asset 的关联；
--   V1 简化为全体可见，泄露面只有 tag 关联关系，无内容风险）
-- asset_tags: INSERT / DELETE → is_admin()
```

## download_sources

```sql
-- SELECT（网盘链接只给登录用户，Guest 不可得）
auth.uid() is not null
and exists (select 1 from assets a
            where a.id = asset_id and a.status='published')
and enabled = true
-- admin 另行放开：
or is_admin()
-- INSERT / UPDATE / DELETE
is_admin()
```

> USER 能否 Package Download 的最终防线就在这里：Guest 查询不到任何网盘 URL。

## audit_logs

```sql
-- SELECT
is_admin()
-- INSERT / UPDATE / DELETE
无客户端策略（触发器 security definer 写入；Worker service role 补写 user.role_changed 等）
```

## 验证清单（Phase 8 逐条执行）

```plaintext
[ ] anon 直接 select draft asset      → 0 行
[ ] anon select draft language/images → 0 行
[ ] anon select download_sources      → 0 行
[ ] user select download_sources      → enabled=true 且 asset published
[ ] user insert/update/delete assets  → 拒绝
[ ] user insert images                → 拒绝
[ ] user update user_roles            → 拒绝
[ ] user insert audit_logs            → 拒绝
[ ] admin 全部上述操作                 → 通过
[ ] admin 经 Worker 改角色             → 通过 + audit 记录
```
