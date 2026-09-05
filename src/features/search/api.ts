import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'
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

  if (query.length > MAX_QUERY_LEN) throw new SearchValidationError(t('errors.queryTooLong'))
  if (tagList.length > MAX_TAG_FILTERS) throw new SearchValidationError(t('errors.tooManyTags'))

  const { data, error } = await supabase.rpc('search_assets', {
    p_q: query || null,
    p_tags: tagList.length ? tagList : null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as PublishedAssetRow[]
}

/** 分页结果信封（Phase 9 D1/D2）：rows + 同筛选下的 total */
export interface PagedSearch {
  rows: PublishedAssetRow[]
  total: number
}

/**
 * 分页搜索：走 search_assets_paged RPC（与 search_assets 同一 core 筛选，顺序一致）。
 * 也用于用户侧首页"无关键词"分页浏览（q='' → 全量 published，updated_at DESC）。
 */
export async function searchAssetsPaged(
  q: string,
  tags: string[],
  page: number,
  perPage: number,
): Promise<PagedSearch> {
  const query = (q ?? '').trim()
  const tagList = Array.from(new Set((tags ?? []).map((t) => t.trim()).filter(Boolean)))

  if (query.length > MAX_QUERY_LEN) throw new SearchValidationError(t('errors.queryTooLong'))
  if (tagList.length > MAX_TAG_FILTERS) throw new SearchValidationError(t('errors.tooManyTags'))

  const { data, error } = await supabase.rpc('search_assets_paged', {
    p_q: query || null,
    p_tags: tagList.length ? tagList : null,
    p_page: Math.max(page, 1),
    p_per_page: Math.min(Math.max(perPage, 1), 100),
  })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<PublishedAssetRow & { total?: number }>
  const total = rows.length ? Number(rows[0].total ?? rows.length) : 0
  // 剥离 total，返回契约与 PublishedAssetRow 一致
  const cleaned = rows.map(({ total: _t, ...rest }) => rest) as PublishedAssetRow[]
  return { rows: cleaned, total }
}
