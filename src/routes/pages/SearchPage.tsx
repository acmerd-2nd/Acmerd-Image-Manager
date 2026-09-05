import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, X } from 'lucide-react'
import type { AssetCardRow, TagRow } from '@/types/database'
import { searchAssetsPaged, SearchValidationError } from '@/features/search/api'
import { listTags } from '@/features/tags/api'
import { AssetCard } from '@/features/assets/AssetCard'
import { useLocale } from '@/i18n'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { CardGridSkeleton } from '@/components/CardSkeleton'
import { Pagination } from '@/components/Pagination'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 24

/**
 * 搜索结果页：关键词 + 标签筛选（AND），结果恒为 Asset Cards。
 * URL 状态：/search?q=<kw>&tags=<slug,slug>&page=N（可分享、可回退）。分页走 search_assets_paged。
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const { t } = useLocale()
  const q = params.get('q') ?? ''
  const selectedTags = useMemo(
    () => (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    [params],
  )
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const [query, setQuery] = useState(q)
  const [allTags, setAllTags] = useState<TagRow[]>([])
  const [results, setResults] = useState<AssetCardRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listTags().then(setAllTags).catch(() => setAllTags([]))
  }, [])
  useEffect(() => {
    setQuery(q)
  }, [q])

  useEffect(() => {
    let cancelled = false
    setResults(null)
    setError(null)
    searchAssetsPaged(q, selectedTags, page, PAGE_SIZE)
      .then(({ rows, total: count }) => {
        if (cancelled) return
        setResults(rows)
        setTotal(count)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof SearchValidationError ? e.message : t('common.error'))
        setResults([])
      })
    return () => {
      cancelled = true
    }
  }, [q, selectedTags, page, t])

  const updateParams = (nextQ: string, nextTags: string[], nextPage = 1) => {
    const p = new URLSearchParams()
    if (nextQ) p.set('q', nextQ)
    if (nextTags.length) p.set('tags', nextTags.join(','))
    if (nextPage > 1) p.set('page', String(nextPage))
    setParams(p)
  }
  const toggleTag = (slug: string) => {
    const next = selectedTags.includes(slug) ? selectedTags.filter((s) => s !== slug) : [...selectedTags, slug]
    updateParams(q, next, 1) // 改筛选回到第 1 页
  }
  const setPage = (p: number) => updateParams(q, selectedTags, p)

  const hasActive = q !== '' || selectedTags.length > 0

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold">{t('search.title')}</h1>

      <form
        className="mb-6 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          updateParams(query.trim(), selectedTags, 1)
        }}
      >
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search.placeholder')} />
        </div>
        <Button type="submit">{t('common.search')}</Button>
      </form>

      {allTags.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{t('search.filterByTag')}</span>
          {allTags.map((tag) => {
            const active = selectedTags.includes(tag.slug)
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTag(tag.slug)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent',
                )}
              >
                {tag.name}
              </button>
            )
          })}
          {hasActive && (
            <Button size="sm" variant="ghost" onClick={() => updateParams('', [], 1)} className="h-7 gap-1 text-xs">
              <X className="h-3 w-3" />
              {t('common.clear')}
            </Button>
          )}
        </div>
      )}

      {error && <p className="py-8 text-center text-sm text-destructive">{error}</p>}

      {!error && results === null ? (
        <CardGridSkeleton count={8} />
      ) : !error && results && results.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">{t('search.noResults')}</p>
          {q && <p className="mt-1 text-sm text-muted-foreground">{t('search.noResultsFor', { q })}</p>}
        </div>
      ) : (
        !error &&
        results && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {results.map((a) => (
                <AssetCard key={a.id} asset={a} />
              ))}
            </div>
            <Pagination page={page} perPage={PAGE_SIZE} total={total} onPage={setPage} />
          </>
        )
      )}
    </div>
  )
}
