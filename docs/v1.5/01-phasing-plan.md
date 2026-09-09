# V1.5 360° 产品展示 — 分阶段实施计划（供 Owner 审阅）

> 依据：Owner 提供《360度资产展示.txt》（完整功能规格，产品语义已冻结）+ Owner 指示「先出分阶段计划，有效控制进程」。
> 本文件只是**施工路线图**；正式 Design Gate 在 Phase 0 产出后另行审批。未经 Gate 审批不动生产库、不传生产图、不动 Download/Credits 语义。

## 硬性规则（引自规格，全程有效）

1. **一个产品功能，四种后台帧密度**：36/72/144/360 只是资源规格，前台永远只有一个「360° View」，任何 UI 不得出现帧数模式
2. **Asset 级能力，与 Language 完全解耦**（切语言 360 不变）
3. 与普通 images 表分开建模（`asset_360_sequences` / `asset_360_frames`）；`assets.active_360_sequence_id` 决定前台唯一启用序列
4. GitHub 存储：`assets/{asset-id}/360/{sequence-id}/{frame}.png`（UUID 路径，防覆盖、易回滚）；复用现有 GitHub 图仓库与 `ghPutFile` 通道，**不建新存储**
5. 播放顺序只认 `frame_index`，不认文件名
6. 一致性：GitHub PUT → SHA 校验 → DB ready；孤儿帧进 sweeper
7. 360 是预览系统：**0 积分、不进 ZIP/Package、无单帧下载**
8. 性能：首帧优先、附近帧预载 + LRU 缓存（16–24 上限）、绝不一次加载全部、不阻塞首屏
9. 无 360 数据 = 前台完全无此模块（不留空盒子）

## 现状可复用资产（已确认存在）

- `worker/github.ts`：`ghPutFile`（sha 校验 + 冲突重试）、删除通道、`SubrequestBudget`
- `images` 四态模型（uploading/ready/failed/deleting）+ sweeper 对账先例（0014）
- `src/lib/image-source.ts` URL 统一出口（CDN 切换口）
- RLS 范式（0012/0016）、审计 allowlist 机制（现 44 项）、隔离库冒烟脚手架（v1311/v142 可复制）
- Worker multipart 上传先例（github-upload 端点）

---

## Phase 0 — 现状审计 + Design Gate（纯读+文档，成本最低）

**做什么**：
1. 精读 `worker/github.ts`（删除助手/预算机制）、sweeper 全文、`AdminAssetEditorPage` 上传流、`AssetDetailPage` 现结构、audit allowlist 现值
2. 产出 `docs/v1.5/02-design-gate.md`，确认规格要求的 10 项：两表 schema、`active_360_sequence_id`、GitHub 路径、状态机、写入一致性、preload/LRU 策略、Language 解耦、Download/Credits 解耦、Security/RLS/Worker、Mobile/Desktop UX
3. 一并给出**留给 Gate 的开放决策点**（我先给建议，Owner 裁决）：
   - 前台读面：`published_360` 视图（照 0015/0021 范式，注意视图加列只能末尾追加）vs 直查两表+RLS —— 建议：只读视图 `published_360_frames`（含 sequence 元信息 + frame 列表）
   - **批量上传协议**（最大技术风险）：144/360 张无法单请求 → 分批端点（每批 N 张 multipart）+ complete 校验端点；批次大小、失败续传语义
   - `assets.active_360_sequence_id` FK 的 ON DELETE 行为（建议 SET NULL，配「先下线再删」流程）
   - sweeper 扩展范围（孤儿帧对账 / failed 序列清理）
   - 同 Asset 多序列并存上限（建议无硬限，靠 Admin 纪律 + Remove）

**交付**：Design Gate 文档 → **STOP 等 Owner 逐项裁决**

## Phase A — 数据模型 + 读面（DB only）

**做什么**：
1. 0022 迁移：两表 + `assets.active_360_sequence_id` + RLS（镜像既有范式：anon/user 只读「active 且 ready」序列的帧；Admin 全权）+ 审计 allowlist 扩（`360.sequence.created/activated/deleted/upload.failed`，44→48，防窄化 DO 块）+ grants
2. 读面视图（按 Gate 裁决）
3. 隔离库冒烟（照 v142 脚手架）：CHECK 约束、frame_index 唯一、RLS 正反样本、可见性 NO-DRIFT

**交付**：冒烟报告 → **STOP：Owner 授权后生产应用 0022**

## Phase B — 后台上传/管理链路（最重的一阶段，建议内部再拆两步）

**B1 — Worker 端点与状态机**：
- `POST /api/admin/assets/:id/360-sequences`（建 draft，指定 frame_count）
- `POST .../sequences/:id/frames`（分批传帧：GitHub PUT + SHA 校验 + 帧 DB 行 ready）
- `POST .../sequences/:id/complete`（校验帧数齐全 → sequence ready）
- `POST .../sequences/:id/activate`（原子切换 `active_360_sequence_id`，先下线旧 active 才删——规格 §17/§47）
- `DELETE .../sequences/:id`（active 不可直删：先置 null → deleting → sweeper 清 GitHub）
- sweeper 扩展：孤儿帧/未完成序列对账
- 沙箱验证（本地 worker + 隔离库，含失败注入：SHA 不匹配/缺帧/中途断）

**B2 — Admin UI**（AdminAssetEditorPage 新卡「360° Product Preview」）：
- 无序列态：[Upload 360° Sequence] → 选帧数（36/72/144/360 + Basic/Standard/High/Ultra 轻提示）→ 选 PNG → 客户端强校验（数量不符直接拒绝、格式、按文件名/选择顺序重编号）→ 分批上传进度
- 序列态：Status/Frames + [Preview][Activate][Replace][Remove]；Preview 用真实播放器拖一圈确认后再 Activate
- 审计验证

**交付**：沙箱证据 → **STOP：Owner 授权生产部署 + 真实序列上传验证**

## Phase C — 前台 Viewer

**做什么**：
1. `SpinViewer` 组件（独立文件）：Pointer Events 拖拽（桌面）/触摸横滑（`abs(dx)>abs(dy)` 才旋转，不抢纵向滚动）/键盘 ←→ 逐帧/Auto Rotate（单速、默认关）/Fullscreen（独立 overlay，Esc 退出，复用 Lightbox 的 scroll-lock 思路但不塞进 Lightbox）
2. 加载策略：首帧优先可交互 → ±N 邻帧预载（方向感知）→ `Map<frameIndex, HTMLImageElement>` LRU（上限按实测 16–24）；加载失败 → 重试态不崩页
3. `make360FrameUrl`（内部走 image-source.ts 出口，页面组件零拼 URL）
4. AssetDetailPage 集成：360° View 在 Gallery 之前；i18n zh/en；无 active 序列零渲染

**交付**：本地/生产走查 → **STOP：Owner 授权生产部署**

## Phase D — QA / 性能 / 移动端 + 收口

**做什么**：
1. 验收矩阵全跑（规格 §53）：四规格上传、数量错误拒绝、Preview/Activate/Replace/Remove、拖拽/滑动手势/键盘/Auto Rotate/Fullscreen/Esc、语言切换 360 不变、0 积分、ZIP/Package 不含 360、单帧不可下载
2. 性能实测：首帧时间、拖动流畅度、内存上限、移动端真机
3. 生产验证脚本（可复跑）+ 收口报告 + HANDOVER/看板/记忆更新 + push

---

## 进程控制（回应 Owner 的核心关切）

| 阶段 | 规模 | 会话成本预估 | STOP 点 |
| --- | --- | --- | --- |
| Phase 0 | 纯读+文档 | 小 | Gate 逐项裁决 |
| Phase A | 1 迁移+冒烟 | 中 | 生产库应用授权 |
| Phase B1 | Worker 最重 | 大（可单独一个会话） | 沙箱证据审查 |
| Phase B2 | Admin UI | 中 | 合并到 B1 授权 |
| Phase C | Viewer 组件 | 中大 | 生产部署授权 |
| Phase D | QA+收口 | 中 | 收口报告确认 |

- 每阶段独立 commit；任何阶段中断都有清晰交接点（commit + 文档即交接）
- 建议节奏：每个 STOP 点由你确认后我再推进；B1 若单会话做不完，代码+冒烟脚本入库即安全暂停
- 本计划与《360度资产展示.txt》冲突时以 txt 为准（它是产品规格）；本计划只补充施工顺序与控制点
