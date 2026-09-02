// 与 supabase/migrations 对应的最小类型集；Phase 3 起逐步补全
export type AppRole = 'user' | 'admin'
export type AssetStatus = 'draft' | 'published' | 'archived'
export type LanguageStatus = 'draft' | 'published'
export type LanguageCode = 'en' | 'de' | 'it' | 'fr' | 'es'

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
