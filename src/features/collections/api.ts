import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'
import type { AssetCardRow, AssetRow, CollectionRow, PublishedCollectionRow } from '@/types/database'

/**
 * V1.1 PC-2：Collection 数据访问层。
 * - 公开读：published_collections 视图（收敛：published + 至少 1 个双层 published 资产）
 * - Admin 读：RLS is_admin 放行；写路径走 Worker admin 端点（原子 mutation + Worker 层审计，
 *   0012 范式；Service Role 只在 Worker Secret，绝不进浏览器）。
 */
export async function listPublishedCollections(): Promise<PublishedCollectionRow[]> {
  const { data, error } = await supabase
    .from('published_collections')
    .select('*')
    .order('sort_order')
  if (error) throw new Error(error.message)
  return (data ?? []) as PublishedCollectionRow[]
}

export async function getPublishedCollectionBySlug(slug: string): Promise<PublishedCollectionRow | null> {
  const { data, error } = await supabase
    .from('published_collections')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PublishedCollectionRow) ?? null
}

/** Admin：全部状态合集列表（RLS is_admin） */
export async function listAllCollections(): Promise<CollectionRow[]> {
  const { data, error } = await supabase
    .from('collections')
    .select('*')
    .order('sort_order')
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as CollectionRow[]
}

/** Admin：该 Collection 内全部状态资产 */
export async function listAssetsInCollection(collectionId: string): Promise<AssetRow[]> {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('collection_id', collectionId)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetRow[]
}

/** Admin：未归组资产（collection_id null；Q3：仅 Admin 可见，不进公域） */
export async function listUngroupedAssets(): Promise<AssetRow[]> {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .is('collection_id', null)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetRow[]
}

/**
 * 首页「更多资源」区：未归组（collection_id null）且双层 published 的资产。
 * 经 published_assets 视图 + assets.collection_id 过滤（视图行含 id 可关联）。
 * Q3 裁决：未归组不进主浏览流，仅在首页折叠区展示。
 */
export async function listPublishedUngroupedAssets(): Promise<AssetCardRow[]> {
  const { data: ungroupedIds, error: idErr } = await supabase
    .from('assets')
    .select('id')
    .is('collection_id', null)
  if (idErr) throw new Error(idErr.message)
  const ids = (ungroupedIds ?? []).map((r) => r.id as string)
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('published_assets')
    .select('*')
    .in('id', ids)
    .order('slug')
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AssetCardRow[]
}

/** /collection/:slug：该 Collection 下双层 published 资产（published_assets 视图 + 归属过滤） */
export async function listPublishedAssetsInCollection(collectionSlug: string): Promise<AssetCardRow[]> {
  const { data: col, error: colErr } = await supabase
    .from('collections')
    .select('id')
    .eq('slug', collectionSlug)
    .eq('status', 'published')
    .maybeSingle()
  if (colErr) throw new Error(colErr.message)
  if (!col) return []
  const { data: memberIds, error: idErr } = await supabase
    .from('assets')
    .select('id')
    .eq('collection_id', col.id)
  if (idErr) throw new Error(idErr.message)
  const ids = (memberIds ?? []).map((r) => r.id as string)
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('published_assets')
    .select('*')
    .in('id', ids)
    .order('slug')
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AssetCardRow[]
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error(t('admin.api.unauthorized'))
  return { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
}

async function collectionRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const headers = await adminHeaders()
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: { code?: string; message?: string } }
    | null
  if (!res.ok || (payload && payload.ok === false)) {
    const err = new Error(
      payload?.error?.message ?? t('admin.api.requestFailed', { status: res.status }),
    ) as Error & { code?: string }
    err.code = payload?.error?.code
    throw err
  }
  return payload as T
}

export interface AdminCollectionMutationResult {
  ok: true
  collection: CollectionRow
}

export function createCollection(input: { name: string; slug: string; description?: string | null }) {
  return collectionRequest<AdminCollectionMutationResult>('/api/admin/collections', input)
}

export function updateCollection(
  id: string,
  patch: {
    name?: string
    slug?: string
    description?: string | null
    status?: 'draft' | 'published' | 'archived'
    sort_order?: number
  },
) {
  return collectionRequest<AdminCollectionMutationResult>(`/api/admin/collections/${id}`, patch, 'PATCH')
}

export function deleteCollection(id: string) {
  return collectionRequest<{ ok: true }>(`/api/admin/collections/${id}`, undefined, 'DELETE')
}

/** 资产归组/移出（collectionId=null 即移出；服务端守卫 cover-in-use） */
export function assignAssetToCollection(assetId: string, collectionId: string | null) {
  return collectionRequest<{ ok: true }>('/api/admin/collections/assign', {
    asset_id: assetId,
    collection_id: collectionId,
  })
}
