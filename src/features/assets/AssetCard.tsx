import { Link } from 'react-router-dom'
import type { AssetCardRow, ImageRow } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { imageSrcOf, THUMB_COVER } from '@/features/assets/api'
import { useLocale } from '@/i18n'

export function AssetCard({ asset }: { asset: AssetCardRow }) {
  const { t } = useLocale()

  // V1.9.0 P0-2：封面字段已并入 published_assets 视图，直出、无每卡查询（消 N+1）
  const coverUrl = asset.cover_provider
    ? imageSrcOf(
        {
          provider: asset.cover_provider as ImageRow['provider'],
          storage_path: asset.cover_storage_path,
          source_path: asset.cover_source_path,
        },
        THUMB_COVER,
      )
    : null

  return (
    <Link to={`/asset/${asset.slug}`} className="group block">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
        <div className="aspect-square bg-muted">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={asset.name}
              loading="lazy"
              decoding="async"
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
            {asset.image_count} {t('asset.images')} · {asset.language_count} {t('asset.languages')}
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
