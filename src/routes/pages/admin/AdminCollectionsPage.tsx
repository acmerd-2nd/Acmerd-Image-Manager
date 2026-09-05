import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
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
import { slugify } from '@/features/assets/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/**
 * V1.1 PC-2：Collection 管理页（Admin）。
 * 读走 RLS（admin 直连）；写统一走 Worker admin 端点（原子 + 审计）。
 * 排序：V1 用上移/下移（sort_order 两次原子 PATCH），拖拽留待后续。
 * 归组：列表内直接加未归组资产；移出带 cover 守卫提示（DB 触发器终审）。
 */
export function AdminCollectionsPage() {
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const [collections, setCollections] = useState<CollectionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 新建表单
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  // 选中合集的管理区
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [members, setMembers] = useState<AssetRow[] | null>(null)
  const [ungrouped, setUngrouped] = useState<AssetRow[] | null>(null)
  const [assetQuery, setAssetQuery] = useState('')

  const [confirmDelete, setConfirmDelete] = useState<CollectionRow | null>(null)

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
      setError(code === 'slug_taken' ? t('admin.collections.slugTaken') : msg)
    }
    setBusy(false)
  }

  const onCreate = () =>
    run(async () => {
      const name = newName.trim()
      if (!name) throw new Error(t('admin.collections.nameRequired'))
      const slug = slugify(name)
      if (!slug) throw new Error(t('admin.collections.slugInvalid'))
      await createCollection({ name, slug, description: newDesc.trim() || null })
      setNewName('')
      setNewDesc('')
    })

  const onTransition = (col: CollectionRow, to: 'draft' | 'published' | 'archived') =>
    run(async () => {
      if (to === 'published' && !col.cover_image_id) {
        throw new Error(t('admin.collections.publishBlocked'))
      }
      await updateCollection(col.id, { status: to })
    })

  // sort_order 交换：两次原子 PATCH（V1 上移/下移；失败可重放，无部分态风险）
  const onMove = (col: CollectionRow, dir: -1 | 1) => {
    if (!collections) return
    const sorted = [...collections].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex((c) => c.id === col.id)
    const target = sorted[idx + dir]
    if (!target) return
    run(async () => {
      await updateCollection(col.id, { sort_order: target.sort_order })
      await updateCollection(target.id, { sort_order: col.sort_order })
    })
  }

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
          {[...collections]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((col, idx, arr) => (
              <Card key={col.id}>
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
                    <Button size="sm" variant="outline" disabled={busy || idx === 0} onClick={() => onMove(col, -1)}>
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || idx === arr.length - 1}
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
            ))}
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
