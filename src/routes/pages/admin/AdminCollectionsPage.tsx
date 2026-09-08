import { useCallback, useEffect, useState } from 'react'
import { ImagePlus, Plus } from 'lucide-react'
import type { AssetRow, CollectionRow } from '@/types/database'
import {
  assignAssetToCollection,
  createCollection,
  deleteCollection,
  listAllCollections,
  listAssetsInCollection,
  listUngroupedAssets,
  updateCollection,
} from '@/features/collections/api'
import { getCoverUrls, slugify } from '@/features/assets/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/**
 * V1.1 PC-2 + V1.2-A：Collection 管理页（Admin）。
 * 读走 RLS（admin 直连）；写统一走 Worker admin 端点（原子 + 审计）。
 * 排序：V1 用上移/下移（sort_order 两次原子 PATCH），拖拽留待后续；V1.2-A 起仅在同级兄弟间移动。
 * 层级：新建/编辑可选父级（防环/深度≤5 由 DB 触发器终审，Worker 预检父级存在性）。
 * 归组：列表内直接加未归组资产；移出带 cover 守卫提示（DB 触发器终审）。
 */

/** 按层级 DFS 展开（roots → 各级子级，组内按 sort_order），供树形渲染 */
function flattenTree(rows: CollectionRow[]): Array<{ col: CollectionRow; depth: number }> {
  const byParent = new Map<string | null, CollectionRow[]>()
  for (const c of rows) {
    const list = byParent.get(c.parent_id) ?? []
    list.push(c)
    byParent.set(c.parent_id, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort_order - b.sort_order)
  const out: Array<{ col: CollectionRow; depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    for (const col of byParent.get(parent) ?? []) {
      out.push({ col, depth })
      walk(col.id, depth + 1)
    }
  }
  walk(null, 0)
  // 防御：孤儿（父级意外缺失）也兜底展示，避免丢数据
  if (out.length !== rows.length) {
    const seen = new Set(out.map((x) => x.col.id))
    for (const c of rows) if (!seen.has(c.id)) out.push({ col: c, depth: 0 })
  }
  return out
}

/** 收集子孙集合 id（含自身），供父级选择器排除（防环的客户端预判；终审仍在 DB） */
function descendantIds(rows: CollectionRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const c of rows) {
    if (c.parent_id) {
      const list = childrenOf.get(c.parent_id) ?? []
      list.push(c.id)
      childrenOf.set(c.parent_id, list)
    }
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const ch of childrenOf.get(cur) ?? []) if (!out.has(ch)) { out.add(ch); stack.push(ch) }
  }
  return out
}

export function AdminCollectionsPage() {
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const [collections, setCollections] = useState<CollectionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 新建表单
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newParentId, setNewParentId] = useState<string>('')

  // 选中合集的管理区
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editParentId, setEditParentId] = useState<string>('')
  const [members, setMembers] = useState<AssetRow[] | null>(null)
  const [ungrouped, setUngrouped] = useState<AssetRow[] | null>(null)
  const [assetQuery, setAssetQuery] = useState('')

  const [confirmDelete, setConfirmDelete] = useState<CollectionRow | null>(null)
  // V1.3.1 G2：封面选图 Dialog（成员资产图片网格）
  const [coverPickerOpen, setCoverPickerOpen] = useState(false)
  const [memberCovers, setMemberCovers] = useState<Map<string, string>>(new Map())

  const reload = useCallback(async () => {
    try {
      setCollections(await listAllCollections())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  const selected = collections?.find((c) => c.id === selectedId) ?? null

  // 选中合集变化时同步父级选择器
  useEffect(() => {
    setEditParentId(selected?.parent_id ?? '')
  }, [selectedId, selected?.parent_id])

  // 成员 + 未归组列表：busy 翻转（每次 mutation 后）触发重读
  useEffect(() => {
    if (!selectedId) {
      setMembers(null)
      setUngrouped(null)
      return
    }
    let cancelled = false
    listAssetsInCollection(selectedId)
      .then((rows) => {
        if (!cancelled) setMembers(rows)
        // G2：成员封面图 URL（选图 Dialog 用）
        const ids = rows.map((r) => r.cover_image_id).filter((v): v is string => !!v)
        getCoverUrls(ids).then((m) => {
          if (!cancelled) setMemberCovers(m)
        }).catch(() => undefined)
      })
      .catch(() => {
        if (!cancelled) setMembers([])
      })
    listUngroupedAssets()
      .then((rows) => {
        if (!cancelled) setUngrouped(rows)
      })
      .catch(() => {
        if (!cancelled) setUngrouped([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, busy])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      const code = (e as Error & { code?: string }).code
      const msg = e instanceof Error ? e.message : String(e)
      if (code === 'slug_taken') setError(t('admin.collections.slugTaken'))
      else if (code === 'collection_has_children') setError(t('admin.collections.hasChildren'))
      else if (code === 'collection_guard' || code === 'parent_not_found') setError(t('admin.collections.hierarchyGuard'))
      else setError(msg)
    }
    setBusy(false)
  }

  const onCreate = () =>
    run(async () => {
      const name = newName.trim()
      if (!name) throw new Error(t('admin.collections.nameRequired'))
      const slug = slugify(name)
      if (!slug) throw new Error(t('admin.collections.slugInvalid'))
      await createCollection({
        name,
        slug,
        description: newDesc.trim() || null,
        parentId: newParentId || null,
      })
      setNewName('')
      setNewDesc('')
      setNewParentId('')
    })

  const onTransition = (col: CollectionRow, to: 'draft' | 'published' | 'archived') =>
    run(async () => {
      if (to === 'published' && !col.cover_image_id) {
        throw new Error(t('admin.collections.publishBlocked'))
      }
      await updateCollection(col.id, { status: to })
    })

  // sort_order 交换：两次原子 PATCH（V1.2-A 起仅在同级兄弟间移动）
  const onMove = (col: CollectionRow, dir: -1 | 1) => {
    if (!collections) return
    const siblings = [...collections]
      .filter((c) => c.parent_id === col.parent_id)
      .sort((a, b) => a.sort_order - b.sort_order)
    const idx = siblings.findIndex((c) => c.id === col.id)
    const target = siblings[idx + dir]
    if (!target) return
    run(async () => {
      await updateCollection(col.id, { sort_order: target.sort_order })
      await updateCollection(target.id, { sort_order: col.sort_order })
    })
  }

  // V1.3.1 G2：设置/移除封面（本合集资产图片；归属越界由 DB 守卫终审）
  const onSetCover = (imageId: string | null) =>
    run(async () => {
      try {
        if (selected) await updateCollection(selected.id, { coverImageId: imageId })
        setCoverPickerOpen(false)
      } catch (e) {
        if ((e as Error & { code?: string }).code === 'collection_guard') {
          throw new Error(t('admin.collections.moveGuard'))
        }
        throw e
      }
    })

  // V1.2-A：换父（null=升根；客户端先排除自身+子孙，环/深度由 DB 触发器终审）
  const onChangeParent = (col: CollectionRow, parentId: string) =>
    run(async () => {
      await updateCollection(col.id, { parentId: parentId || null })
    })

  const onAssign = (assetId: string, collectionId: string | null) =>
    run(async () => {
      try {
        await assignAssetToCollection(assetId, collectionId)
      } catch (e) {
        if ((e as Error & { code?: string }).code === 'collection_guard') {
          throw new Error(t('admin.collections.moveGuard'))
        }
        throw e
      }
    })

  const filteredUngrouped = (ungrouped ?? []).filter((a) =>
    assetQuery.trim() ? a.name.toLowerCase().includes(assetQuery.trim().toLowerCase()) : true,
  )

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('admin.page.collections')}</h1>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 新建 */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex max-w-xl gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('admin.collections.newName')}
            />
            <Button size="sm" disabled={busy || !newName.trim()} onClick={onCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t('admin.collections.create')}
            </Button>
          </div>
          <Input
            className="max-w-xl"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={t('admin.collections.description')}
          />
          {/* V1.2-A：父级选择（根级 = 无父级；防环/深度终审在 DB 触发器） */}
          <div className="flex max-w-xl items-center gap-2">
            <label className="shrink-0 text-sm text-muted-foreground" htmlFor="new-parent">
              {t('admin.collections.parentLabel')}
            </label>
            <select
              id="new-parent"
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              value={newParentId}
              onChange={(e) => setNewParentId(e.target.value)}
            >
              <option value="">{t('admin.collections.parentRoot')}</option>
              {(collections ?? [])
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">{t('admin.collections.createAndManage')}</p>
        </CardContent>
      </Card>

      {collections === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : collections.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('admin.collections.empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {flattenTree(collections).map(({ col, depth }) => {
            // 兄弟间首位/末位判定（V1.2-A：上移/下移仅同级生效）
            const siblings = collections.filter((c) => c.parent_id === col.parent_id)
            const isFirstSibling = siblings.every((s) => s.sort_order >= col.sort_order)
            const isLastSibling = siblings.every((s) => s.sort_order <= col.sort_order)
            return (
              <Card key={col.id} style={{ marginLeft: `${depth * 20}px` }}>
                <CardContent className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="truncate font-medium hover:underline"
                      onClick={() => setSelectedId(selectedId === col.id ? null : col.id)}
                    >
                      {col.name}
                    </button>
                    <div className="truncate text-xs text-muted-foreground">
                      /{col.slug}
                      {col.description ? ` · ${col.description}` : ''}
                    </div>
                  </div>
                  <Badge
                    variant={
                      col.status === 'published' ? 'default' : col.status === 'draft' ? 'secondary' : 'outline'
                    }
                  >
                    {col.status === 'published'
                      ? t('admin.status.published')
                      : col.status === 'draft'
                        ? t('admin.status.draft')
                        : t('admin.status.archived')}
                  </Badge>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isFirstSibling}
                      onClick={() => onMove(col, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isLastSibling}
                      onClick={() => onMove(col, 1)}
                    >
                      ↓
                    </Button>
                    {col.status !== 'published' && (
                      <Button size="sm" disabled={busy} onClick={() => onTransition(col, 'published')}>
                        {t('admin.action.publish')}
                      </Button>
                    )}
                    {col.status === 'published' && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(col, 'draft')}>
                        {t('admin.action.unpublish')}
                      </Button>
                    )}
                    {col.status !== 'archived' && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(col, 'archived')}>
                        {t('admin.action.archive')}
                      </Button>
                    )}
                    {col.status === 'archived' && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(col, 'draft')}>
                        {t('admin.action.restore')}
                      </Button>
                    )}
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(col)}>
                      {t('admin.action.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* 选中合集：成员管理 */}
      {selected && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{t('admin.collections.assetsSection')}</h2>
              <span className="text-xs text-muted-foreground">{t('admin.collections.notVisibleHint')}</span>
            </div>

            {/* V1.2-A：换父级（排除自身+子孙，防环；深度/环终审在 DB 触发器） */}
            <div className="flex max-w-md items-center gap-2">
              <label className="shrink-0 text-sm text-muted-foreground" htmlFor="edit-parent">
                {t('admin.collections.parentLabel')}
              </label>
              <select
                id="edit-parent"
                className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={editParentId}
                disabled={busy}
                onChange={(e) => onChangeParent(selected, e.target.value)}
              >
                <option value="">{t('admin.collections.parentRoot')}</option>
                {(collections ?? [])
                  .filter((c) => !descendantIds(collections ?? [], selected.id).has(c.id))
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>

            {/* V1.3.1 G2：封面管理卡（无封面明确空态 / 有封面预览+更换+移除） */}
            <div className="border-t pt-3">
              <div className="text-sm font-medium">{t('admin.collections.coverManageTitle')}</div>
              {selected.cover_image_id ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <div className="h-20 w-32 overflow-hidden rounded-md border bg-muted">
                    {memberCovers.get(selected.cover_image_id) ? (
                      <img
                        src={memberCovers.get(selected.cover_image_id)}
                        alt={selected.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Spinner className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy || !members || members.length === 0} onClick={() => setCoverPickerOpen(true)}>
                      {t('admin.collections.coverChange')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onSetCover(null)}>
                      {t('admin.collections.coverRemove')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-4">
                  <div className="text-sm text-muted-foreground">{t('admin.collections.coverNone')}</div>
                  <Button size="sm" disabled={busy || !members || members.length === 0} onClick={() => setCoverPickerOpen(true)}>
                    <ImagePlus className="mr-1 h-4 w-4" />
                    {t('admin.collections.coverSetBtn')}
                  </Button>
                </div>
              )}
            </div>

            {members === null ? (
              <Spinner className="h-5 w-5" />
            ) : members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('collection.empty')}</p>
            ) : (
              <div className="space-y-1">
                {members.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {a.name}
                      <span className="ml-2 text-xs text-muted-foreground">/{a.slug}</span>
                    </span>
                    {selected.cover_image_id && a.cover_image_id === selected.cover_image_id && (
                      <Badge variant="secondary">{t('admin.editor.cover')}</Badge>
                    )}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onAssign(a.id, null)}>
                      {t('admin.collections.removeAsset')}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* 添加未归组资产 */}
            <div className="space-y-2 border-t pt-3">
              <div className="text-sm font-medium">{t('admin.collections.addAsset')}</div>
              <Input
                value={assetQuery}
                onChange={(e) => setAssetQuery(e.target.value)}
                placeholder={t('admin.collections.addAssetPlaceholder')}
              />
              {filteredUngrouped.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('admin.collections.noMatchingAssets')}</p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {filteredUngrouped.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        {a.name}
                        <span className="ml-2 text-xs text-muted-foreground">/{a.slug}</span>
                      </span>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => onAssign(a.id, selected.id)}>
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('common.confirm')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* V1.3.1 G2：可视化选图（仅本合集资产的图片；点击选中 → 设为封面） */}
      {coverPickerOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setCoverPickerOpen(false)}>
          <div
            className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3 className="text-lg font-semibold">{t('admin.collections.coverPickTitle')}</h3>
            {members && members.length > 0 && members.some((a) => a.cover_image_id) ? (
              <>
                <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {members
                    .filter((a) => a.cover_image_id && memberCovers.get(a.cover_image_id))
                    .map((a) => {
                      const url = memberCovers.get(a.cover_image_id!)
                      const isCurrent = selected.cover_image_id === a.cover_image_id
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={'relative overflow-hidden rounded-md border-2 ' + (isCurrent ? 'border-primary' : 'border-transparent hover:border-muted-foreground/40')}
                          onClick={() => onSetCover(a.cover_image_id)}
                        >
                          <img src={url} alt={a.name} className="aspect-[4/3] w-full object-cover" />
                          <div className="truncate px-1 py-1 text-xs text-muted-foreground">{a.name}</div>
                          {isCurrent && (
                            <span className="absolute right-1 top-1 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                              ✓
                            </span>
                          )}
                        </button>
                      )
                    })}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{t('admin.collections.coverPickHint')}</p>
              </>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">{t('admin.collections.coverEmpty')}</p>
            )}
            <div className="mt-6 flex justify-end">
              <Button variant="outline" onClick={() => setCoverPickerOpen(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('admin.assets.deleteTitle', { name: confirmDelete?.name ?? '' })}
        destructive
        confirmLabel={t('admin.action.delete')}
        description={confirmDelete ? t('admin.collections.deleteBody') : ''}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() =>
          confirmDelete &&
          run(async () => {
            await deleteCollection(confirmDelete.id)
            if (selectedId === confirmDelete.id) setSelectedId(null)
            setConfirmDelete(null)
          })
        }
      />
    </div>
  )
}
