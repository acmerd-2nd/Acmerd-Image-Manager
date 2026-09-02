import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import type { AssetCardRow } from '@/types/database'
import { AssetCard } from '@/features/assets/AssetCard'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'

export function HomePage() {
  const [assets, setAssets] = useState<AssetCardRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('published_assets')
      .select('*')
      .order('id')
      .then(({ data, error: err }) => {
        if (err) setError(err.message)
        else setAssets(data ?? [])
      })
  }, [])

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
        <p className="text-sm text-destructive">Failed to load assets: {error}</p>
      ) : assets === null ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <p className="font-medium">No assets published yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The library is empty. Admin can create the first asset in the console.
          </p>
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
