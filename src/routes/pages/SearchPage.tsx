import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import type { AssetCardRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'

export function SearchPage() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [query, setQuery] = useState(q)

  useEffect(() => {
    let req = supabase.from('published_assets').select('*')
    if (q) req = req.or(`name.ilike.%${q}%,description.ilike.%${q}%,tags.cs.{${q}}`)
    req.then(({ data }) => setAssets(data ?? []))
  }, [q])

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold">Search</h1>
      <form
        className="mb-8 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          window.location.assign(`/search?q=${encodeURIComponent(query.trim())}`)
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assets..." />
        <Button type="submit">Search</Button>
      </form>
      {assets === null ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      ) : assets.length === 0 ? (
        <p className="py-20 text-center text-muted-foreground">
          No results{q ? ` for “${q}”` : ''}.
        </p>
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
