import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AssetCardRow } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { getCoverUrls } from '@/features/assets/api'

export function AssetCard({ asset }: { asset: AssetCardRow }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (asset.cover_image_id) {
      getCoverUrls([asset.cover_image_id]).then((map) => {
        if (!cancelled) setCoverUrl(map.get(asset.cover_image_id!) ?? null)
      })
    }
    return () => {
      cancelled = true
    }
  }, [asset.cover_image_id])

  return (
    <Link to={`/asset/${asset.slug}`} className="group block">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
        <div className="aspect-[4/3] bg-muted">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={asset.name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="text-3xl">🖼️</span>
            </div>
          )}
        </div>
        <CardContent className="p-4">
          <div className="truncate font-medium">{asset.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {asset.image_count} Images · {asset.language_count} Languages
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {asset.tags.slice(0, 3).map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
