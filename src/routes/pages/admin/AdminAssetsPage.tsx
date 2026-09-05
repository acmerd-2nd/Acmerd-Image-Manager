import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import type { AssetRow, AssetStatus } from '@/types/database'
import { deleteAsset, getCoverUrls, listAllAssetsPaged, listImages, transitionAsset } from '@/features/assets/api'
import { deleteGithubImage } from '@/features/assets/github'
import { deleteStoragePaths } from '@/features/assets/storage'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Pagination } from '@/components/Pagination'
import { useToast } from '@/components/ToastProvider'

const STATUS_BADGE: Record<AssetStatus, { labelKey: string; variant: 'default' | 'secondary' | 'outline' }> = {
  draft: { labelKey: 'admin.status.draft', variant: 'secondary' },
  published: { labelKey: 'admin.status.published', variant: 'default' },
  archived: { labelKey: 'admin.status.archived', variant: 'outline' },
}
const PAGE_SIZE = 20

export function AdminAssetsPage() {
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const [assets, setAssets] = useState<AssetRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [covers, setCovers] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AssetRow | null>(null)
  const { isAdmin } = useAuth()
  const toast = useToast()

  const reload = useCallback(async () => {
    try {
      const { rows, total: t } = await listAllAssetsPaged(page, PAGE_SIZE)
      setAssets(rows)
      setTotal(t)
      const coverMap = await getCoverUrls(
        rows.map((r) => r.cover_image_id).filter((v): v is string => !!v),
      )
      setCovers(coverMap)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [page])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

  const setPage = (p: number) => {
    const next = new URLSearchParams(params)
    if (p <= 1) next.delete('page')
    else next.set('page', String(p))
    setParams(next)
  }

  const handleTransition = async (asset: AssetRow, to: AssetStatus) => {
    setBusy(true)
    setError(null)
    try {
      await transitionAsset(asset.id, to)
      toast.success(
        to === 'published'
          ? t('admin.assets.published', { name: asset.name })
          : to === 'archived'
            ? t('admin.assets.archivedMsg', { name: asset.name })
            : t('admin.assets.unpublished', { name: asset.name }),
      )
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(e instanceof Error ? e.message : t('admin.assets.operationFailed'))
    }
    setBusy(false)
  }

  const handleDelete = async (asset: AssetRow) => {
    setBusy(true)
    setError(null)
    try {
      // 收集精确 storage_path（目录级前缀删除不可靠，见 storage.ts 注释）
      const imgs = await listImages(asset.id)
      // V1.1 PB-1: GitHub 行先经 Worker 四态闭环删远端（级联前，sweeper 可追踪）
      for (const img of imgs.filter((i) => i.provider === 'github')) {
        await deleteGithubImage(img.id).catch(() => {
          setError(t('admin.misc.githubCleanupFailed', { name: img.filename }))
        })
      }
      await deleteAsset(asset.id) // DB 行级联 + asset.deleted 审计
      await deleteStoragePaths(
        imgs.filter((i) => i.provider !== 'github' && i.storage_path).map((i) => i.storage_path as string),
      ).catch((e) => {
        setError(t('admin.assets.storageCleanupFailed', { msg: e instanceof Error ? e.message : String(e) }))
      })
      setConfirmDelete(null)
      toast.success(t('admin.assets.deleted', { name: asset.name }))
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(e instanceof Error ? e.message : t('admin.assets.deleteFailed'))
    }
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('admin.page.assets')}</h1>
        <Button asChild size="sm">
          <Link to="/admin/assets/new" className="flex items-center gap-1">
            <Plus className="h-4 w-4" />
            {t('admin.newAsset')}
          </Link>
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {assets === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : assets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('admin.createFirst')}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {assets.map((a) => {
              const badge = STATUS_BADGE[a.status]
              return (
                <Card key={a.id}>
                  <CardContent className="flex flex-wrap items-center gap-4 p-3">
                    <div className="h-14 w-20 shrink-0 overflow-hidden rounded bg-muted">
                      {a.cover_image_id && covers.get(a.cover_image_id) ? (
                        <img src={covers.get(a.cover_image_id)} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-lg">🖼️</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link to={`/admin/assets/${a.id}`} className="truncate font-medium hover:underline">
                        {a.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">
                        /{a.slug} · {t('common.updated')} {new Date(a.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>
                    <div className="flex shrink-0 gap-1">
                      {a.status === 'draft' && (
                        <Button size="sm" disabled={busy} onClick={() => handleTransition(a, 'published')}>
                          {t('admin.action.publish')}
                        </Button>
                      )}
                      {a.status === 'published' && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => handleTransition(a, 'draft')}>
                            {t('admin.action.unpublish')}
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => handleTransition(a, 'archived')}>
                            {t('admin.action.archive')}
                          </Button>
                        </>
                      )}
                      {a.status === 'archived' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => handleTransition(a, 'draft')}
                          title={t('admin.assets.restoreHint')}
                        >
                          {t('admin.action.restore')}
                        </Button>
                      )}
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(a)}>
                        {t('admin.action.delete')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
          <Pagination page={page} perPage={PAGE_SIZE} total={total} onPage={setPage} />
        </>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('admin.assets.deleteTitle', { name: confirmDelete?.name ?? '' })}
        destructive
        confirmLabel={t('admin.action.delete')}
        description={confirmDelete ? t('admin.assets.deleteBody') : ''}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
      />
    </div>
  )
}
