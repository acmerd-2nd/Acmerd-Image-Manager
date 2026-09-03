import { supabase } from '@/lib/supabase/client'
import type {
  AssetLanguageRow,
  AssetRow,
  AssetStatus,
  ImageRow,
  LanguageCode,
  PublishedAssetRow,
} from '@/types/database'

/**
 * Phase 3 Asset 数据访问层。
 * 全部走前端 Supabase Client（Publishable Key + 登录 JWT），
 * 权限完全由 RLS 承担 —— 这里不做、也不需要任何前端权限判断。
 */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// ---------------- Asset ----------------

export async function createAsset(input: {
  name: string
  slug: string
  description?: string | null
}): Promise<AssetRow> {
  const { data, error } = await supabase
    .from('assets')
    .insert({ name: input.name, slug: input.slug, description: input.description ?? null })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as AssetRow
}

export async function getAsset(id: string): Promise<AssetRow | null> {
  const { data, error } = await supabase.from('assets').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as AssetRow) ?? null
}

export async function updateAsset(
  id: string,
  patch: Partial<Pick<AssetRow, 'name' | 'slug' | 'description' | 'cover_image_id' | 'status'>>,
): Promise<void> {
  const { error } = await supabase.from('assets').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Admin 删除 Asset：DB 行级联；Storage 清理由调用方另行走 Worker 端点 */
export async function deleteAsset(id: string): Promise<void> {
  const { error } = await supabase.from('assets').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function listAllAssets(): Promise<AssetRow[]> {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetRow[]
}

export function transitionAsset(id: string, to: AssetStatus): Promise<void> {
  return updateAsset(id, { status: to })
}

// ---------------- Languages ----------------

export async function listLanguages(assetId: string): Promise<AssetLanguageRow[]> {
  const { data, error } = await supabase
    .from('asset_languages')
    .select('*')
    .eq('asset_id', assetId)
    .order('language_code')
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetLanguageRow[]
}

export async function createLanguage(
  assetId: string,
  languageCode: LanguageCode,
): Promise<AssetLanguageRow> {
  const { data, error } = await supabase
    .from('asset_languages')
    .insert({ asset_id: assetId, language_code: languageCode })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as AssetLanguageRow
}

export async function deleteLanguage(languageId: string): Promise<void> {
  const { error } = await supabase.from('asset_languages').delete().eq('id', languageId)
  if (error) throw new Error(error.message)
}

export async function setLanguageStatus(languageId: string, status: 'draft' | 'published') {
  const { error } = await supabase.from('asset_languages').update({ status }).eq('id', languageId)
  if (error) throw new Error(error.message)
}

// ---------------- Images ----------------

export async function listImages(assetId: string): Promise<ImageRow[]> {
  // Admin：RLS 放行全部；经 language → asset 关联过滤本资产
  const { data, error } = await supabase
    .from('images')
    .select('*, asset_languages!inner(asset_id)')
    .eq('asset_languages.asset_id', assetId)
    .order('sort_order')
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ImageRow[]
}

export async function createImageRow(input: {
  asset_language_id: string
  filename: string
  storage_path: string
  mime_type: string
  file_size: number
  width?: number | null
  height?: number | null
  sort_order: number
}): Promise<ImageRow> {
  const { data, error } = await supabase.from('images').insert(input).select('*').single()
  if (error) throw new Error(error.message)
  return data as ImageRow
}

export async function deleteImageRow(imageId: string): Promise<void> {
  const { error } = await supabase.from('images').delete().eq('id', imageId)
  if (error) throw new Error(error.message)
}

/** 上移/下移排序：交换两行的 sort_order（Phase 9 再升级拖拽） */
export async function swapImageOrder(a: ImageRow, b: ImageRow): Promise<void> {
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    supabase.from('images').update({ sort_order: b.sort_order }).eq('id', a.id),
    supabase.from('images').update({ sort_order: a.sort_order }).eq('id', b.id),
  ])
  if (e1) throw e1
  if (e2) throw e2
}

// ---------------- 用户端（published 链路） ----------------

export async function listPublishedAssets(): Promise<PublishedAssetRow[]> {
  const { data, error } = await supabase
    .from('published_assets')
    .select('*')
    .order('slug')
  if (error) throw new Error(error.message)
  return (data ?? []) as PublishedAssetRow[]
}

export async function getPublishedAssetBySlug(slug: string): Promise<PublishedAssetRow | null> {
  const { data, error } = await supabase
    .from('published_assets')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PublishedAssetRow) ?? null
}

// ---------------- 封面公开 URL ----------------

/** storage_path 形如 images/{asset}/{lang}/{file}，含 bucket 名；公开 URL 需去掉第一段 */
export function toPublicUrl(storagePath: string): string {
  const withoutBucket = storagePath.split('/').slice(1).join('/')
  const { data } = supabase.storage.from('images').getPublicUrl(withoutBucket)
  return data.publicUrl
}

/**
 * 展示用图片 URL（Phase 9 D4）：走 Supabase render/image 变换，集中一处生成，
 * 禁止各页各写 query 参数。仅服务展示链路；下载原图/ZIP 不经此函数（保持 Phase 5 不变量）。
 */
export interface ImageVariant {
  width: number
  height: number
  quality?: number
}
export const THUMB_COVER: ImageVariant = { width: 640, height: 480, quality: 80 } // 卡片 4:3
export const THUMB_GRID: ImageVariant = { width: 640, height: 640, quality: 80 } // 详情 1:1

export function makeImageSrc(storagePath: string, variant: ImageVariant): string {
  const withoutBucket = storagePath.split('/').slice(1).join('/')
  const { data } = supabase.storage.from('images').getPublicUrl(withoutBucket)
  const params = new URLSearchParams({
    resize: 'cover',
    width: String(variant.width),
    height: String(variant.height),
    quality: String(variant.quality ?? 80),
  })
  return data.publicUrl.replace('/object/public/', '/render/image/public/') + '?' + params.toString()
}

export async function getCoverUrls(imageIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (imageIds.length === 0) return map
  const { data, error } = await supabase
    .from('images')
    .select('id, storage_path')
    .in('id', imageIds)
  if (error) throw new Error(error.message)
  for (const row of (data ?? []) as Array<{ id: string; storage_path: string }>) {
    map.set(row.id, makeImageSrc(row.storage_path, THUMB_COVER))
  }
  return map
}

// ---------------- Admin 资产分页（Phase 9 D2：.range() 零迁移，含全部状态） ----------------

export interface PagedAssets {
  rows: AssetRow[]
  total: number
}

/**
 * Admin 资产列表分页：直接 PostgREST .range + .count('exact')。
 * 排序 updated_at DESC, id ASC（与用户侧一致的确定性序）；可见性由 RLS is_admin 放行全部状态。
 */
export async function listAllAssetsPaged(page: number, perPage: number): Promise<PagedAssets> {
  const safePer = Math.min(Math.max(perPage, 1), 100)
  const safePage = Math.max(page, 1)
  const from = (safePage - 1) * safePer
  const { data, error, count } = await supabase
    .from('assets')
    .select('*', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, from + safePer - 1)
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as AssetRow[], total: count ?? 0 }
}

// ---------------- Phase 4：按语言浏览 ----------------

/**
 * 用户端详情：某 published 资产的 published 语言。
 * RLS 双层过滤（asset.status='published' AND language.status='published'），
 * 未发布语言不会出现在结果里 —— 这是安全边界，不是 UI 隐藏。
 */
export async function listPublishedLanguages(assetId: string): Promise<AssetLanguageRow[]> {
  const { data, error } = await supabase
    .from('asset_languages')
    .select('*')
    .eq('asset_id', assetId)
    .eq('status', 'published')
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetLanguageRow[]
}

/** 用户端详情：指定 published 语言下的图片（按 sort_order） */
export async function listImagesByLanguage(languageId: string): Promise<ImageRow[]> {
  const { data, error } = await supabase
    .from('images')
    .select('*')
    .eq('asset_language_id', languageId)
    .order('sort_order')
  if (error) throw new Error(error.message)
  return (data ?? []) as ImageRow[]
}
