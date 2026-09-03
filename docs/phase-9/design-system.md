# ACMERD Design System — 基线（Phase 9 D9）

> 目的：把现有分散的 shadcn 风格内联样式**收敛为单一事实来源**，不引入 UI 框架、不重设计。
> 现状：tokens 已在 `src/index.css`（CSS 变量）+ `tailwind.config.ts`（映射）落地；本文件固化约定供后续阶段与 Agent 遵守。

## 1. 颜色（语义 token，`index.css :root` / `.dark`）
| Token | 用途 |
| --- | --- |
| `background` / `foreground` | 页面底 / 主文本 |
| `primary` / `primary-foreground` | 主行动、激活态、选中环 |
| `secondary` / `muted` (+ `-foreground`) | 次级背景、弱化文本（元信息、caption） |
| `accent` (+ `-foreground`) | hover / 选中行背景 |
| `destructive` (+ `-foreground`) | 危险操作、错误态 |
| `border` / `input` / `ring` | 描边 / 输入边框 / focus ring |

规则：**禁止硬编码十六进制色**（toast 成功态 `green-600` 为唯一例外，属状态色，见 §6）。

## 2. 字体层级
| 场景 | 类 |
| --- | --- |
| 页标题 H1 | `text-3xl font-bold`（详情/列表页头）；首页 hero `text-4xl font-bold tracking-tight` |
| 区块标题 H2 | `text-xl font-semibold`（Admin 页头）/ `font-medium`（卡片内 section） |
| 正文 | `text-sm`；弱化说明 `text-muted-foreground` |
| 元信息 / caption | `text-xs text-muted-foreground` |
| 品牌 eyebrow | `text-xs font-semibold uppercase tracking-[0.2em]` |

## 3. 间距 / 圆角 / 阴影
- 容器：`mx-auto w-full max-w-7xl px-4 sm:px-6`；页面纵向 `py-12`。
- 卡片内边距 `p-3`~`p-6`；网格 `gap-4`；纵向堆叠 `space-y-2~4`。
- 圆角：卡片/输入 `rounded-lg`/`rounded-md`；pill/chip `rounded-full`。
- 阴影：hover 抬升 `shadow-md`；浮层 `shadow-lg`。

## 4. Form / Control
- `Input`：`h-9` 标准高，focus `ring-1 ring-ring`。
- `Button` variants：`default | secondary | outline | ghost | destructive | link`；size `default | sm | lg | icon`。
- 危险操作必用 `destructive` + `ConfirmDialog` 二次确认。

## 5. 状态与反馈（Phase 9 统一）
- **Loading**：小面积 `Spinner`；卡片网格 `CardGridSkeleton`（比例与真实卡一致，防 CLS）。
- **Empty**：`rounded-xl border border-dashed` 居中说明。
- **Error**：`border-destructive/40 bg-destructive/10 text-destructive` 内联块 + 可重试。
- **Success/Error/Info**：统一走全局 `ToastProvider`（`useToast()`），不再各页自建局部 toast。
- **Confirm**：统一 `ConfirmDialog`。

## 6. 状态色约定
`success=green-600`、`error=destructive`、`info=foreground/background`。新增语义色须先入本表再用。

## 7. 响应式约定（Phase 9 收口）
- 断点：`sm=640 / md=768 / lg=1024`（Tailwind 默认）。
- 资产网格：`grid-cols-2 → sm:grid-cols-3 → lg:grid-cols-4`。
- 详情页：`lg:grid-cols-[1fr_260px]`（侧栏桌面右置、移动下排）。
- Admin：桌面侧栏 `hidden md:block` + 移动 chips `md:hidden`；宽表一律 `overflow-x-auto` 包裹。
- 移动端优先保证**功能可用**（可操作、无横向溢出），不追求视觉重做（D9）。

## 8. 不变量
零运行时 UI 依赖（仅 lucide 图标）；不引入组件库/设计框架；新页面复用以上 token 与组件，禁止另立样式体系。
