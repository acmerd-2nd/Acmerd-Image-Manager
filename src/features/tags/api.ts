import { supabase } from '@/lib/supabase/client'
import type { TagRow } from '@/types/database'

/**
 * Phase 6 Tag 数据访问（Asset 级多对多）。
 * 读公开（RLS select all），写 admin-only（RLS is_admin）；
 * asset_tags 增删由 0005 触发器落 asset.tag_added/removed 审计。
 */

export async function listTags(): Promise<TagRow[]> {
  const { data, error } = await supabase.from('tags').select('*').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as TagRow[]
}

export async function createTag(name: string): Promise<TagRow> {
  // slug 由 0005 触发器自动生成，前端不传
  const { data, error } = await supabase.from('tags').insert({ name: name.trim() }).select('*').single()
  if (error) throw new Error(error.message)
  return data as TagRow
}

export async function renameTag(id: string, name: string): Promise<void> {
  // 仅改 name，slug 保持稳定（D4）
  const { error } = await supabase.from('tags').update({ name: name.trim() }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteTag(id: string): Promise<void> {
  const { error } = await supabase.from('tags').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** 某资产已关联的 tag id 列表 */
export async function listAssetTagIds(assetId: string): Promise<string[]> {
  const { data, error } = await supabase.from('asset_tags').select('tag_id').eq('asset_id', assetId)
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => r.tag_id as string)
}

/**
 * 某资产的标签（含 slug，供详情页可点击筛选）。
 * asset_tags / tags 读公开（RLS select all）；published 资产才进此页，不泄露未发布信息。
 */
export async function listAssetTags(assetId: string): Promise<TagRow[]> {
  const { data, error } = await supabase
    .from('asset_tags')
    .select('tags(id,name,slug,created_at)')
    .eq('asset_id', assetId)
  if (error) throw new Error(error.message)
  return (data ?? [])
    .map((r) => (r as unknown as { tags: TagRow | null }).tags)
    .filter((t): t is TagRow => !!t)
}

export async function addAssetTag(assetId: string, tagId: string): Promise<void> {
  const { error } = await supabase.from('asset_tags').insert({ asset_id: assetId, tag_id: tagId })
  if (error) throw new Error(error.message)
}

export async function removeAssetTag(assetId: string, tagId: string): Promise<void> {
  const { error } = await supabase
    .from('asset_tags')
    .delete()
    .eq('asset_id', assetId)
    .eq('tag_id', tagId)
  if (error) throw new Error(error.message)
}

/** 关联某标签的资产数（删除确认展示用） */
export async function countAssetsForTag(tagId: string): Promise<number> {
  const { count, error } = await supabase
    .from('asset_tags')
    .select('asset_id', { count: 'exact', head: true })
    .eq('tag_id', tagId)
  if (error) throw new Error(error.message)
  return count ?? 0
}
