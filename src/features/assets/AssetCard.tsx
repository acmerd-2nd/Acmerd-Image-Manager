import { Link } from 'react-router-dom'
import type { AssetCardRow } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

export function AssetCard({ asset }: { asset: AssetCardRow }) {
  return (
    <Link to={`/asset/${asset.slug}`} className="group block">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
        <div className="flex aspect-[4/3] items-center justify-center bg-muted">
          {asset.cover_image_id ? (
            <CoverPlaceholder note="cover in Phase 3" />
          ) : (
            <CoverPlaceholder />
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

function CoverPlaceholder({ note }: { note?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center">
      <span className="text-3xl">🖼️</span>
      {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
    </div>
  )
}
