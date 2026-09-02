# 09 · Download Flow

三种下载是**三套独立机制**，代码上分别落在 `features/downloads/` 三个模块，不共享状态。

## A. Single Image Download

```plaintext
USER 在 /asset/:slug 打开 Lightbox (/image/:id)
   ↓ 点击 [ Download ]
前端检查 session（UI Guard；GUEST 时按钮呈锁定态 → 点击弹"登录后下载"）
   ↓ GET /api/downloads/image/:imageId  (Bearer JWT)
Worker：verify JWT → 角色 ∈ user/admin？
   ├─ 否 → 401/403
   └─ 是 → 查 service role：图片存在？所属 asset published？
          ├─ 否 → 404
          └─ 是 → 302 → Supabase Storage URL（浏览器另存）
```

- 文件名：原始 `filename`（Content-Disposition 由 Worker 302 目标带出或前端 download 属性兜底）。

## B. Multi-select ZIP Download

```plaintext
Asset Detail 图格进入"选择模式"
   ↓ 勾选图片 → 底部浮条: "3 selected · [Download Selected] [Clear]"
前端限制: 单 asset_language 内勾选 ≤ 30 张（超出自禁用并提示）
   ↓ POST /api/downloads/zip { assetLanguageId, imageIds } (Bearer JWT)
Worker:
   1. verify JWT + role
   2. 校验 imageIds ⊂ assetLanguageId 且 asset published（service role 查 images）
   3. 限额: 数量 ≤ 30 / 总大小 ≤ 200MB
      └─ 超限 → 413 → 前端 Toast: "Too many images selected. Please download in smaller batches."
   4. 流式打包: 按 sort_order 顺序取对象 → ZIP(store 模式, 不压缩) → 边取边写 response
   5. Content-Disposition: {slug}-{lang}.zip
浏览器接收 → 下载
```

- 中途失败（存储对象缺失）：已流出的字节无法回滚，策略为**跳过缺失对象**并在响应头 `X-Zip-Skipped: n` 标记，前端可提示部分成功。
- V1 无后台队列、无断点续传；Workers 限制（CPU 时间/内存）决定了流式 + store 模式是必须项。

## C. Package Download（网盘）

```plaintext
Asset Detail 侧栏读取 download_sources (RLS: 登录用户 + enabled + asset published)
   ↓ 按 provider 分组 enabled 源
n = 0  → 不渲染 [Download Package] 按钮（整块隐藏）
n = 1  → [Download Package] 单按钮, 点击 window.open(url) 直接跳转
n = 2  → [Download Package] → 弹出 Popover/Dialog:
         ┌──────────────────────┐
         │  Choose a source     │
         │  [ Quark Drive    ]  │
         │  [ Baidu Netdisk  ]  │
         └──────────────────────┘
```

- **与当前语言完全解耦**：语言切换只影响图片 Grid；Package 区域的数据源与渲染逻辑独立订阅，不接收 language state。
- `download_sources` 查询条件（RLS + 查询双重保险）：`enabled=true AND asset.status='published' AND auth.uid() is not null`。
- GUEST 看不到任何网盘 URL（RLS 返回 0 行），UI 上按钮位置显示为登录引导。

## 验收对照（总纲 56 条）

```plaintext
单张下载        ✓ Worker 302
选 1 张 ZIP     ✓
选多张 ZIP      ✓
Quark=null Baidu=null   → 按钮 hidden
Quark only      → direct redirect
Baidu only      → direct redirect
Both            → selector
```
