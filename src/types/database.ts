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
  storage_path: string
  mime_type: string | null
  file_size: number | null
  width: number | null
  height: number | null
  sort_order: number
  created_at: string
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
