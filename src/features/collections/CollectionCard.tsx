import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen } from 'lucide-react'
import type { PublishedCollectionRow } from '@/types/database'
import { getCoverUrls } from '@/features/assets/api'
import { useLocale } from '@/i18n'
import { Card, CardContent } from '@/components/ui/card'

/** V1.1 PC-2：首页 Collection 卡片（cover = cover_image_id 经 makeImageUrl；无图占位） */
export function CollectionCard({ collection }: { collection: PublishedCollectionRow }) {
  const { t } = useLocale()
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (collection.cover_image_id) {
      getCoverUrls([collection.cover_image_id]).then((map) => {
        if (!cancelled) setCoverUrl(map.get(collection.cover_image_id!) ?? null)
      })
    }
    return () => {
      cancelled = true
    }
  }, [collection.cover_image_id])

  return (
    <Link to={`/collection/${collection.slug}`} className="group block">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
        <div className="aspect-[4/3] bg-muted">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={collection.name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <FolderOpen className="h-10 w-10 text-muted-foreground/60" />
            </div>
          )}
        </div>
        <CardContent className="p-4">
          <div className="truncate font-medium">{collection.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t('collection.assetsCount', { n: collection.asset_count })}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
