# 10 · Multi-language Flow

## 数据生命周期

```plaintext
Admin 在 Asset 编辑页添加语言版本 (asset_languages 行, status=draft)
   ↓ 上传图片到 images/{asset_id}/{lang}/ （DB 写 images 行, sort_order 递增）
   ↓ 调整顺序 / 删除 / 设 Cover
   ↓ [ Publish Language ] → status=published
前台立即可见该语言 Tab
   ↓ 需要下架时 [ To Draft ] → 前台隐藏, 数据保留
```

- 语言固定集合：`en de it fr es`，UI 名称映射：English / Deutsch / Italiano / Français / Español。
- `asset.status` 与 `language.status` 独立：Asset 必须 published，语言才可能被前台看到；Asset draft/archived 时无论语言状态一律不可见（RLS 双层检查）。

## 前台切换逻辑

```plaintext
/asset/:slug  加载 → 拉取该 asset 的 published 语言列表 (RLS 已过滤)
   ↓ 默认选中: en 若存在, 否则第一个 published 语言
语言 Tab 条: [English] [Deutsch] [Italiano] [Español]   ← 只列 published
   ↓ 点击切换 → 仅替换 Image Grid 数据 (images by asset_language_id)
   → 不重新加载 Asset, 不改 URL (或 ?lang=de 仅同步状态), 不新建 Asset
URL 状态: /asset/neck-massager?lang=de → 刷新后保持所选语言
```

- 未发布的语言（如 FR draft）**绝不会出现**在 Tab 中，也不会在 API 结果里（RLS 保证）。
- Admin 预览模式（/admin/assets/:id）可查看 draft 语言内容，但那是后台页面，与前台隔离。

## 与其他模块的边界

| 模块 | 是否受语言切换影响 | 说明 |
| --- | --- | --- |
| Image Grid | ✅ | 切换 = 替换 images 数据源 |
| 单图下载 / ZIP | ✅ | 下载的是"当前语言"的图（ZIP 请求绑定 assetLanguageId） |
| Cover | ❌ | Asset 级，一张封面服务所有语言 |
| Tags | ❌ | Asset 级 |
| **Package Download** | ❌ **绝不耦合** | 独立组件独立数据源，见 09-C |

## 验收对照（总纲 57 条）

```plaintext
EN✅ DE✅ IT✅ FR(draft) ES✅
前台 Tab 只出现: English / Deutsch / Italiano / Español
选中 German → Grid 显示 German Images
点击 Package → Quark / Baidu（与 German 无关, 不变化）
```
