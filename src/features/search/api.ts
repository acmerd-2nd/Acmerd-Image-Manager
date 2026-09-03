import { supabase } from '@/lib/supabase/client'
import type { PublishedAssetRow } from '@/types/database'

/**
 * Phase 6 Search —— Query Layer。
 * UI → features/search → search_assets() RPC → published_assets → RLS。
 * 结果恒为 Asset 级；双层可见性由视图 + SECURITY INVOKER 保证，前端不写权限逻辑。
 */

// 有界校验（与 0005 RPC 内一致，前端先行拦截改善体验）
export const MAX_QUERY_LEN = 200
export const MAX_TAG_FILTERS = 10

export class SearchValidationError extends Error {}

export async function searchAssets(q: string, tags: string[]): Promise<PublishedAssetRow[]> {
  const query = (q ?? '').trim()
  const tagList = Array.from(new Set((tags ?? []).map((t) => t.trim()).filter(Boolean)))

  if (query.length > MAX_QUERY_LEN) throw new SearchValidationError('搜索关键词过长')
  if (tagList.length > MAX_TAG_FILTERS) throw new SearchValidationError('筛选标签过多')

  const { data, error } = await supabase.rpc('search_assets', {
    p_q: query || null,
    p_tags: tagList.length ? tagList : null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as PublishedAssetRow[]
}
