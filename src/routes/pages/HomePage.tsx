import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import type { AssetCardRow, PublishedCollectionRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { CollectionCard } from '@/features/collections/CollectionCard'
import { listPublishedCollections, listPublishedUngroupedAssets } from '@/features/collections/api'
import { searchAssetsPaged } from '@/features/search/api'
import { useLocale } from '@/i18n'
import { Input } from '@/components/ui/input'
import { CardGridSkeleton } from '@/components/CardSkeleton'
import { Pagination } from '@/components/Pagination'
import { useToast } from '@/components/ToastProvider'

const PAGE_SIZE = 24

export function HomePage() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const toast = useToast()
  const { t } = useLocale()

  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [collections, setCollections] = useState<PublishedCollectionRow[] | null>(null)
  const [uncategorized, setUncategorized] = useState<AssetCardRow[] | null>(null)
  const [showUncategorized, setShowUncategorized] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    listPublishedCollections()
      .then((rows) => {
        if (!cancelled) setCollections(rows)
      })
      .catch(() => {
        if (!cancelled) setCollections([])
      })
    listPublishedUngroupedAssets()
      .then((rows) => {
        if (!cancelled) setUncategorized(rows)
      })
      .catch(() => {
        if (!cancelled) setUncategorized([])
      })
    searchAssetsPaged('', [], page, PAGE_SIZE)
      .then(({ rows, total: count }) => {
        if (cancelled) return
        setAssets(rows)
        setTotal(count)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setAssets([])
      })
    return () => {
      cancelled = true
    }
  }, [page])

  const setPage = (p: number) => {
    const next = new URLSearchParams(params)
    if (p <= 1) next.delete('page')
    else next.set('page', String(p))
    setParams(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10 max-w-2xl">
        <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {t('home.eyebrow')}
        </div>
        <h1 className="text-4xl font-bold tracking-tight">{t('home.title')}</h1>
        <p className="mt-3 text-muted-foreground">{t('home.subtitle')}</p>
        <div className="relative mt-6 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t('home.searchPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const q = (e.target as HTMLInputElement).value.trim()
                window.location.assign(`/search?q=${encodeURIComponent(q)}`)
              }
            }}
          />
        </div>
      </div>

      {/* V1.1 PC-2：首页 = Collection 卡片（Q3：未归组资产折叠在页面底部区） */}
      {collections === null ? (
        <div className="mb-10 h-24 animate-pulse rounded-xl bg-muted" />
      ) : collections.length > 0 ? (
        <section className="mb-12">
          <h2 className="mb-4 text-lg font-semibold">{t('collection.featured')}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {collections.map((col) => (
              <CollectionCard key={col.id} collection={col} />
            ))}
          </div>
        </section>
      ) : (
        <div className="mb-12 rounded-xl border border-dashed py-10 text-center">
          <p className="text-sm text-muted-foreground">{t('collection.noCollections')}</p>
        </div>
      )}

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="font-medium text-destructive">{t('home.loadFailed')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            className="mt-3 text-sm underline"
            onClick={() => {
              setAssets(null)
              searchAssetsPaged('', [], page, PAGE_SIZE)
                .then(({ rows, total: count }) => {
                  setAssets(rows)
                  setTotal(count)
                  setError(null)
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : t('common.error')))
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : assets === null ? (
        <CardGridSkeleton count={8} />
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">{t('home.emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('home.emptySubtitle')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </div>
          <Pagination page={page} perPage={PAGE_SIZE} total={total} onPage={setPage} />
        </>
      )}

      {/* 未归组已发布资产（Q3 裁决：不进主浏览流，折叠于此；有内容才显示） */}
      {uncategorized !== null && uncategorized.length > 0 && (
        <section className="mt-14 border-t pt-8">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setShowUncategorized((v) => !v)}
          >
            <span>
              <span className="text-lg font-semibold">{t('collection.uncategorizedTitle')}</span>
              <span className="ml-3 text-sm text-muted-foreground">
                {t('collection.uncategorizedSubtitle')}
              </span>
            </span>
            <span className="text-sm text-muted-foreground">
              {showUncategorized ? '−' : '+'} {uncategorized.length}
            </span>
          </button>
          {showUncategorized && (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {uncategorized.map((a) => (
                <AssetCard key={a.id} asset={a} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
