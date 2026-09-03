import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import type { AssetCardRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { searchAssetsPaged } from '@/features/search/api'
import { Input } from '@/components/ui/input'
import { CardGridSkeleton } from '@/components/CardSkeleton'
import { Pagination } from '@/components/Pagination'
import { useToast } from '@/components/ToastProvider'

const PAGE_SIZE = 24

export function HomePage() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const toast = useToast()

  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    searchAssetsPaged('', [], page, PAGE_SIZE)
      .then(({ rows, total: t }) => {
        if (cancelled) return
        setAssets(rows)
        setTotal(t)
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
          ACMERD · 探知
        </div>
        <h1 className="text-4xl font-bold tracking-tight">Image Library</h1>
        <p className="mt-3 text-muted-foreground">Explore visual resources.</p>
        <div className="relative mt-6 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search assets..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const q = (e.target as HTMLInputElement).value.trim()
                window.location.assign(`/search?q=${encodeURIComponent(q)}`)
              }
            }}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="font-medium text-destructive">加载失败</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            className="mt-3 text-sm underline"
            onClick={() => {
              setAssets(null)
              searchAssetsPaged('', [], page, PAGE_SIZE)
                .then(({ rows, total: t }) => {
                  setAssets(rows)
                  setTotal(t)
                  setError(null)
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : '重试失败'))
            }}
          >
            重试
          </button>
        </div>
      ) : assets === null ? (
        <CardGridSkeleton count={8} />
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">No assets published yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The library is empty. Admin can create the first asset in the console.
          </p>
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
    </div>
  )
}
