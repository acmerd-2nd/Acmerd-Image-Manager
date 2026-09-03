import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, X } from 'lucide-react'
import type { AssetCardRow, TagRow } from '@/types/database'
import { searchAssets, SearchValidationError } from '@/features/search/api'
import { listTags } from '@/features/tags/api'
import { AssetCard } from '@/features/assets/AssetCard'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

/**
 * 搜索结果页：关键词 + 标签筛选（AND），结果恒为 Asset Cards。
 * URL 状态：/search?q=<kw>&tags=<slug,slug>（可分享、可回退）。
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const selectedTags = useMemo(
    () => (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    [params],
  )

  const [query, setQuery] = useState(q)
  const [allTags, setAllTags] = useState<TagRow[]>([])
  const [results, setResults] = useState<AssetCardRow[] | null>(null)
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
    searchAssets(q, selectedTags)
      .then((rows) => {
        if (!cancelled) setResults(rows)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof SearchValidationError ? e.message : '搜索失败，请稍后再试')
        setResults([])
      })
    return () => {
      cancelled = true
    }
  }, [q, selectedTags])

  const updateParams = (nextQ: string, nextTags: string[]) => {
    const p = new URLSearchParams()
    if (nextQ) p.set('q', nextQ)
    if (nextTags.length) p.set('tags', nextTags.join(','))
    setParams(p)
  }

  const toggleTag = (slug: string) => {
    const next = selectedTags.includes(slug)
      ? selectedTags.filter((s) => s !== slug)
      : [...selectedTags, slug]
    updateParams(q, next)
  }

  const clearAll = () => updateParams('', [])

  const hasActive = q !== '' || selectedTags.length > 0

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold">Search</h1>

      <form
        className="mb-6 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          updateParams(query.trim(), selectedTags)
        }}
      >
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search assets by name, description, or tag..."
          />
        </div>
        <Button type="submit">Search</Button>
      </form>

      {/* 标签筛选 chips */}
      {allTags.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Filter by tag:</span>
          {allTags.map((t) => {
            const active = selectedTags.includes(t.slug)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggleTag(t.slug)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input hover:bg-accent',
                )}
              >
                {t.name}
              </button>
            )
          })}
          {hasActive && (
            <Button size="sm" variant="ghost" onClick={clearAll} className="h-7 gap-1 text-xs">
              <X className="h-3 w-3" />
              Clear
            </Button>
          )}
        </div>
      )}

      {error && <p className="py-8 text-center text-sm text-destructive">{error}</p>}

      {!error && results === null ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      ) : !error && results && results.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">No results</p>
          {q && <p className="mt-1 text-sm text-muted-foreground">关键词 “{q}” 未匹配到资产</p>}
        </div>
      ) : (
        !error &&
        results && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </div>
        )
      )}
    </div>
  )
}
