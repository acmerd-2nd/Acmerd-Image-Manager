import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen } from 'lucide-react'
import type { PublishedCollectionRow } from '@/types/database'
import { getCoverUrls } from '@/features/assets/api'
import { githubThumbUrl } from '@/lib/image-source'
import { useLocale } from '@/i18n'
import { Card, CardContent } from '@/components/ui/card'

/**
 * V1.1 PC-2：首页 Collection 卡片。
 * V1.7.0：封面优先本地上传（cover_source_path → /api/img 代理），否则回落选中的资产图（cover_image_id）。
 * V1.9.0 P0-1：上传封面经 githubThumbUrl 走 /api/img（可缩放 + 强缓存 + 大陆可达），不再直链 raw 原图。
 */
export function CollectionCard({ collection }: { collection: PublishedCollectionRow }) {
  const { t } = useLocale()
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // 上传封面优先：同步出 URL，无需查 images 表
    if (collection.cover_source_path) {
      setCoverUrl(githubThumbUrl(collection.cover_source_path, 640, 80))
      return () => {
        cancelled = true
      }
    }
    setCoverUrl(null)
    if (collection.cover_image_id) {
      getCoverUrls([collection.cover_image_id]).then((map) => {
        if (!cancelled) setCoverUrl(map.get(collection.cover_image_id!) ?? null)
      })
    }
    return () => {
      cancelled = true
    }
  }, [collection.cover_source_path, collection.cover_image_id])

  return (
    <Link to={`/collection/${collection.slug}`} className="group block">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
        <div className="aspect-square bg-muted">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={collection.name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1">
              <FolderOpen className="h-8 w-8 text-muted-foreground/60" />
              <span className="text-xs text-muted-foreground/80">{t('collection.noCover')}</span>
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
