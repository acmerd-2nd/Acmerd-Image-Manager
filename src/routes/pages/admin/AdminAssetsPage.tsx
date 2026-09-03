import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import type { AssetRow, AssetStatus } from '@/types/database'
import { deleteAsset, getCoverUrls, listAllAssetsPaged, listImages, transitionAsset } from '@/features/assets/api'
import { deleteStoragePaths } from '@/features/assets/storage'
import { useAuth } from '@/features/auth/AuthProvider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Pagination } from '@/components/Pagination'
import { useToast } from '@/components/ToastProvider'

const STATUS_BADGE: Record<AssetStatus, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  published: { label: 'Published', variant: 'default' },
  archived: { label: 'Archived', variant: 'outline' },
}
const PAGE_SIZE = 20

export function AdminAssetsPage() {
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

  if (!isAdmin) return <p className="text-sm text-destructive">Admin only.</p>

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
        to === 'published' ? `已发布「${asset.name}」` : to === 'archived' ? `已归档「${asset.name}」` : `已转草稿「${asset.name}」`,
      )
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
    setBusy(false)
  }

  const handleDelete = async (asset: AssetRow) => {
    setBusy(true)
    setError(null)
    try {
      // 收集精确 storage_path（目录级前缀删除不可靠，见 storage.ts 注释）
      const imgs = await listImages(asset.id)
      await deleteAsset(asset.id) // DB 行级联 + asset.deleted 审计
      await deleteStoragePaths(imgs.map((i) => i.storage_path)).catch((e) => {
        setError(`已删除数据，但存储清理失败：${e instanceof Error ? e.message : String(e)}`)
      })
      setConfirmDelete(null)
      toast.success(`已删除「${asset.name}」`)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Assets</h1>
        <Button asChild size="sm">
          <Link to="/admin/assets/new" className="flex items-center gap-1">
            <Plus className="h-4 w-4" />
            New Asset
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
            还没有资产。点击「New Asset」创建第一个。
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
                        /{a.slug} · 更新于 {new Date(a.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    <div className="flex shrink-0 gap-1">
                      {a.status === 'draft' && (
                        <Button size="sm" disabled={busy} onClick={() => handleTransition(a, 'published')}>
                          Publish
                        </Button>
                      )}
                      {a.status === 'published' && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => handleTransition(a, 'draft')}>
                            Unpublish
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => handleTransition(a, 'archived')}>
                            Archive
                          </Button>
                        </>
                      )}
                      {a.status === 'archived' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => handleTransition(a, 'draft')}
                          title="恢复为 Draft，需重新检查后才能 Publish"
                        >
                          Restore
                        </Button>
                      )}
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(a)}>
                        Delete
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
        title={`Delete「${confirmDelete?.name ?? ''}」？`}
        destructive
        confirmLabel="Delete permanently"
        description={
          confirmDelete
            ? '此操作物理删除：\n· Asset 及其全部语言版本与图片记录（级联）\n· Storage 中 images/{assetId}/ 下全部对象\n· 封面引用（随行删除）\n\n该操作不可撤销，审计将记录 asset.deleted。'
            : ''
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
      />
    </div>
  )
}
