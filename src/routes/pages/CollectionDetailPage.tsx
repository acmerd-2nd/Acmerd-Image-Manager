import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { AssetCardRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { getPublishedCollectionBySlug, listPublishedAssetsInCollection } from '@/features/collections/api'
import { useLocale } from '@/i18n'
import { CardGridSkeleton } from '@/components/CardSkeleton'
import { useToast } from '@/components/ToastProvider'

/** V1.1 PC-2：/collection/:slug —— 该 Collection 下双层 published 资产（RLS 收敛） */
export function CollectionDetailPage() {
  const { slug = '' } = useParams()
  const { t } = useLocale()
  const toast = useToast()
  const [collection, setCollection] = useState<Awaited<ReturnType<typeof getPublishedCollectionBySlug>>>(undefined as never)
  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    getPublishedCollectionBySlug(slug)
      .then((row) => {
        if (cancelled) return
        if (!row) setMissing(true)
        else setCollection(row)
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
