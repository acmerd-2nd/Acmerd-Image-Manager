import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'

interface AssetRow {
  id: string
  name: string
  slug: string
  description: string | null
  status: string
}

export function AssetDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [asset, setAsset] = useState<AssetRow | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!slug) return
    supabase
      .from('assets')
      .select('id,name,slug,description,status')
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle()
      .then(({ data }) => {
        if (data) setAsset(data)
        else setNotFound(true)
      })
  }, [slug])

  if (notFound) return <NotFoundInline />
  if (!asset)
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-6 w-6" />
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold">{asset.name}</h1>
      {asset.description && (
        <p className="mt-2 max-w-2xl text-muted-foreground">{asset.description}</p>
      )}
      <Card className="mt-8">
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Image grid, language switcher and downloads arrive in Phase 3–5.
        </CardContent>
      </Card>
    </div>
  )
}

function NotFoundInline() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-24 text-center sm:px-6">
      <h1 className="text-2xl font-semibold">Asset not found</h1>
      <p className="mt-2 text-muted-foreground">It may be unpublished or does not exist.</p>
    </div>
  )
}
