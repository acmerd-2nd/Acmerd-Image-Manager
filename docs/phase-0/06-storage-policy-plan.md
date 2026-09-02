# 06 · Storage Policy Plan

## Bucket

| 项 | 值 |
| --- | --- |
| Bucket | `images` |
| 可见性 | **public**（Guest 要能直接看图；文件名用 uuid 前缀防止路径枚举） |
| 大小限制 | 单文件 ≤ 15 MB（Phase 1 定稿） |
| 允许 MIME | image/jpeg, image/png, image/webp |

## 路径约定（与数据库严格一致）

```plaintext
images/
  {asset_id}/
    en/  01-<uuid8>.jpg
    de/  01-<uuid8>.jpg
    it/  ...
    fr/  ...
    es/  ...
```

- `images.storage_path` 存 `images/{asset_id}/{lang}/{filename}`（含 bucket 名）。
- 上传由 Admin 端直传 Supabase Storage（admin 凭证），或经 Worker（service role）；两者都受策略约束。

## Storage Policies（作用于 storage.objects, bucket_id='images'）

```sql
-- READ：公开（配合 public bucket，游客可直接 GET）
create policy "Public read images" on storage.objects
  for select using (bucket_id = 'images');

-- INSERT：仅 admin
create policy "Admin upload images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and public.is_admin());

-- UPDATE：仅 admin
create policy "Admin update images" on storage.objects
  for update to authenticated
  using (bucket_id = 'images' and public.is_admin());

-- DELETE：仅 admin
create policy "Admin delete images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'images' and public.is_admin());
```

## Worker 访问（ZIP 打包 / 单图下载代理）

- Worker 使用 **Service Role Key**（仅存在于 Worker Secret），可读任意对象。
- ZIP 打包：Worker 按 `storage_path` 批量取文件 → 流式 ZIP（store 模式）→ 响应给浏览器，不落盘。

## 验证清单

```plaintext
[ ] 游客浏览器直接打开 public URL      → 200
[ ] USER 用 anon key Storage upload   → 拒绝
[ ] USER delete 对象                   → 拒绝
[ ] ADMIN upload / delete             → 通过
[ ] DB images.storage_path 与实际对象一一对应（无孤儿/无指向错误）
```
