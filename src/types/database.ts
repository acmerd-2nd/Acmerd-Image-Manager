// 与 supabase/migrations 对应的最小类型集；Phase 3 起逐步补全
export type AppRole = 'user' | 'admin'
export type AssetStatus = 'draft' | 'published' | 'archived'
export type LanguageStatus = 'draft' | 'published'
export type LanguageCode = 'en' | 'de' | 'it' | 'fr' | 'es'

export const LANGUAGE_CODES: LanguageCode[] = ['en', 'de', 'it', 'fr', 'es']
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
  fr: 'Français',
  es: 'Español',
}

export interface AssetRow {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_id: string | null
  status: AssetStatus
  /** V1.1 PC-2：所属 Collection（null=未归组；Q3 裁决：未归组不进公域浏览） */
  collection_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AssetLanguageRow {
  id: string
  asset_id: string
  language_code: LanguageCode
  status: LanguageStatus
  created_at: string
  updated_at: string
}

export interface ImageRow {
  id: string
  asset_language_id: string
  filename: string
  /**
   * V1.1 PB-1 起为 provider 感知真值：supabase_storage 行非空（V1.0 语义），
   * github 行恒 null（source_path 承载，DB CHECK 互斥）。
   * URL 一律经 toPublicUrl/imageSrcOf/makeImageUrl 计算，禁止直接拼 storage_path。
   */
  storage_path: string | null
  provider: ImageProvider
  source_path: string | null
  mime_type: string | null
  file_size: number | null
  width: number | null
  height: number | null
  sort_order: number
  created_at: string
  updated_at: string
}

/** V1.1 D3：图片来源提供方（预留扩展 R2/S3/Cloudflare Images，新增仅增枚举值） */
export type ImageProvider = 'supabase_storage' | 'github'

/** V1.1 D3 双 provider 事实模型：storage_path 与 source_path 按 provider 互斥（DB images_source_check） */
export interface ImageSourceRow {
  id: string
  filename: string
  provider: ImageProvider
  /** provider='supabase_storage' 时非空（含 bucket 名，形如 images/{asset}/{lang}/{file}） */
  storage_path: string | null
  /** provider='github' 时非空（仓库内路径） */
  source_path: string | null
}

/** V1.2-A D1：Collection（任意层级，硬上限 5 层；parent_id=null 为根级） */
export interface CollectionRow {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_id: string | null
  status: AssetStatus
  sort_order: number
  parent_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** published_collections 视图行（V1.2-A 递归链可见性：全链 published 才公开） */
export interface PublishedCollectionRow {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_id: string | null
  asset_count: number
  parent_id: string | null
}

/** V1.1 D10：账号来源标记（仅标记字段，不构成特殊权限类别） */
export type AccountOrigin = 'registered' | 'seed'

/** V1.3.1 G1：进度三状态（与发布态 status 正交） */
export type ScheduleProgress = 'not_started' | 'in_progress' | 'completed'

/** V1.2-B D6 + V1.3.1 G1：排期条目（Admin 全量行） */
export interface ScheduleItemRow {
  id: string
  title: string
  description: string | null
  event_date: string | null
  status: AssetStatus
  progress: ScheduleProgress
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/** published_schedule_items 视图行（D7 + G1：仅 published，event_date asc nulls last + sort_order asc） */
export interface PublishedScheduleItemRow {
  id: string
  title: string
  description: string | null
  event_date: string | null
  sort_order: number
  progress: ScheduleProgress
}

/** V1.1 D7：积分账户（balance 由 RPC 维护，user 侧只读） */
export interface CreditAccountRow {
  user_id: string
  balance: string
  unlimited: boolean
  created_at: string
  updated_at: string
}

/** V1.1 D7：积分流水（Ledger，只追加；user 永久删除后 user_id 置 null 行保留） */
export interface CreditTransactionRow {
  id: number
  user_id: string | null
  type: 'image_download' | 'zip_download' | 'package_download' | 'admin_adjustment' | 'download_refund' | 'seed_initial'
  amount: string
  balance_after: string
  reference_type: string | null
  reference_id: string | null
  idempotency_key: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/** V1.1 D6：站点设置（5 个固定 key，anon/authenticated 只读） */
export type SiteSettingKey = 'single_image_cost' | 'zip_per_image_cost' | 'package_download_cost' | 'registration_enabled' | 'schedule_navigation_enabled'

export interface SiteSettingRow {
  key: SiteSettingKey
  value: string
  updated_at: string
}

/** published_assets 视图行（Phase 3 卡片/详情数据源） */
export interface PublishedAssetRow {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_id: string | null
  image_count: number
  language_count: number
  tags: string[]
}

export interface AssetCardRow {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image_id: string | null
  image_count: number
  language_count: number
  tags: string[]
}

/** tags 表行（Phase 6） */
export interface TagRow {
  id: string
  name: string
  slug: string
  created_at: string
}

/** audit_logs 表行（Phase 7 审计页；D4：admin JWT 经 RLS 直连读取，不走 Worker） */
export interface AuditLogRow {
  id: number
  actor_id: string | null
  action: string
  target_type: string
  target_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
