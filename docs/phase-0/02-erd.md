# 02 · Database ERD

## ERD 图

```mermaid
erDiagram
    auth_users ||--o| profiles : "id = profiles.id"
    profiles ||--o{ user_roles : "user_id"
    assets ||--o{ asset_languages : "asset_id"
    asset_languages ||--o{ images : "asset_language_id"
    assets ||--o{ asset_tags : "asset_id"
    tags ||--o{ asset_tags : "tag_id"
    assets ||--o{ download_sources : "asset_id"
    assets |o--o| images : "cover_image_id"
    profiles ||--o{ audit_logs : "actor_id"

    assets {
        uuid id PK
        text name
        text slug UK
        text description
        uuid cover_image_id FK "指向 images.id，Asset 级唯一封面"
        asset_status status "draft|published|archived"
        uuid created_by FK "profiles.id"
        timestamptz created_at
        timestamptz updated_at
    }
    asset_languages {
        uuid id PK
        uuid asset_id FK
        lang_code language_code "en|de|it|fr|es"
        language_status status "draft|published"
        timestamptz created_at
        timestamptz updated_at
    }
    images {
        uuid id PK
        uuid asset_language_id FK
        text filename
        text storage_path "images/{asset_id}/{lang}/{file}"
        text mime_type
        bigint file_size
        int width
        int height
        int sort_order
        timestamptz created_at
        timestamptz updated_at
    }
    tags {
        uuid id PK
        text name UK
        text slug UK
        timestamptz created_at
    }
    asset_tags {
        uuid asset_id PK_FK
        uuid tag_id PK_FK
    }
    download_sources {
        uuid id PK
        uuid asset_id FK
        provider "quark|baidu"
        text url
        boolean enabled
        timestamptz created_at
        timestamptz updated_at
    }
    profiles {
        uuid id PK "auth.users.id"
        text display_name
        text avatar_url
        boolean disabled "Admin 可禁用用户"
        timestamptz created_at
        timestamptz updated_at
    }
    user_roles {
        uuid user_id PK_FK
        app_role role "user|admin"
        timestamptz created_at
    }
    audit_logs {
        bigserial id PK
        uuid actor_id FK
        text action
        text target_type
        text target_id
        jsonb metadata
        timestamptz created_at
    }
```

## 关系要点（对应总纲验收问题）

| 问题 | 结论 |
| --- | --- |
| Asset 是什么 | 一个产品资源整体；拥有 name/slug/description/status/cover/tags/download_sources |
| Image 属于谁 | 属于 **asset_language**（语言版本），不属于 Asset 直接层 |
| Language 属于谁 | 属于 Asset；`(asset_id, language_code)` 唯一 |
| Cover 怎么定义 | `assets.cover_image_id` 指向任意语言版本下的一张图（通常 EN），Asset 级唯一 |
| Tag 属于谁 | 属于 Asset（asset_tags 多对多），不绑定 Image |
| Download Source 属于谁 | 属于 Asset，与语言无关；`(asset_id, provider)` 唯一，enabled 控制生效 |
| 数据删除策略 | Asset 走逻辑归档 `archived`；物理删除仅限单张图片与 Asset 显式 Delete（带确认 + Audit） |

## 状态机

```plaintext
assets.status:        draft ──publish──▶ published ──unpublish──▶ draft
                                       published ──archive─────▶ archived
asset_languages.status: draft ◀──▶ published   （per language，独立于 Asset 状态）
```

前台可见性条件（RLS 核心表达式）：

```plaintext
Asset 可见    = assets.status = 'published'
Language 可见 = asset.status='published' AND asset_languages.status='published'
Image 可见    = 其 Language 可见
```
