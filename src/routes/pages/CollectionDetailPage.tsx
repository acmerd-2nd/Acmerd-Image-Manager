import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import type { AssetCardRow, PublishedCollectionRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { CollectionCard } from '@/features/collections/CollectionCard'
import {
  getPublishedBreadcrumb,
  getPublishedCollectionBySlug,
  listPublishedAssetsInCollection,
  listPublishedChildCollections,
} from '@/features/collections/api'
import { useLocale } from '@/i18n'
import { CardGridSkeleton } from '@/components/CardSkeleton'
import { useToast } from '@/components/ToastProvider'

/** V1.1 PC-2 + V1.2-A：/collection/:slug —— 面包屑 + 子合集卡 + 双层 published 资产（RLS 收敛） */
export function CollectionDetailPage() {
  const { slug = '' } = useParams()
  const { t } = useLocale()
  const toast = useToast()
  const [collection, setCollection] = useState<Awaited<ReturnType<typeof getPublishedCollectionBySlug>>>(undefined as never)
  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [children, setChildren] = useState<PublishedCollectionRow[]>([])
  const [breadcrumb, setBreadcrumb] = useState<PublishedCollectionRow[]>([])
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    getPublishedCollectionBySlug(slug)
      .then((row) => {
        if (cancelled) return
        if (!row) setMissing(true)
        else {
          setCollection(row)
          // V1.2-A：面包屑祖先链 + 直接子合集（仅全链 published，视图已收敛）
          getPublishedBreadcrumb(row)
            .then((chain) => !cancelled && setBreadcrumb(chain))
            .catch(() => undefined)
          listPublishedChildCollections(row.id)
            .then((rows) => !cancelled && setChildren(rows))
            .catch(() => undefined)
        }
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    listPublishedAssetsInCollection(slug)
      .then((rows) => {
        if (!cancelled) setAssets(rows)
      })
      .catch((e) => {
        if (cancelled) return
        setAssets([])
        toast.error(e instanceof Error ? e.message : t('common.error'))
      })
    return () => {
      cancelled = true
    }
  }, [slug, toast, t])

  if (missing) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-20 text-center sm:px-6">
        <p className="font-medium">{t('collection.notFound')}</p>
        <Link to="/" className="mt-4 inline-block text-sm underline">
          {t('errors.backHome')}
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('collection.backToCollections')}
      </Link>
      <div className="mt-4 mb-8">
        {/* V1.2-A：祖先面包屑（根 → … → 当前合集；自身可点跳转各层级） */}
        {breadcrumb.length > 1 && (
          <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumb.map((b, i) => (
              <span key={b.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5" />}
                {i === breadcrumb.length - 1 ? (
                  <span className="text-foreground">{b.name}</span>
                ) : (
                  <Link to={`/collection/${b.slug}`} className="hover:text-foreground hover:underline">
                    {b.name}
                  </Link>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-3xl font-bold tracking-tight">
          {collection ? collection.name : t('common.loading')}
        </h1>
        {collection?.description && (
          <p className="mt-2 text-muted-foreground">{collection.description}</p>
        )}
        {collection && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('collection.assetsCount', { n: collection.asset_count })}
          </p>
        )}
      </div>

      {/* V1.2-A：子合集卡（仅全链 published；无则不渲染区块） */}
      {children.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 text-lg font-semibold">{t('collection.childCollections')}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {children.map((child) => (
              <CollectionCard key={child.id} collection={child} />
            ))}
          </div>
        </section>
      )}

      {assets === null ? (
        <CardGridSkeleton count={8} />
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">{t('collection.empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <AssetCard key={a.id} asset={a} />
          ))}
        </div>
      )}
    </div>
  )
}
