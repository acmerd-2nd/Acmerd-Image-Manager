import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getPublishedAssetBySlug, listPublishedImages, toPublicUrl } from '@/features/assets/api'
import type { ImageRow, PublishedAssetRow } from '@/types/database'
import { Spinner } from '@/components/spinner'

/**
 * 用户端 Asset 详情（Phase 3）：
 * 仅展示 published Asset 的 published 语言图片；语言切换器属 Phase 4，
 * 下载三件套属 Phase 5 —— 本页只做浏览。
 */
export function AssetDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [asset, setAsset] = useState<PublishedAssetRow | null>(null)
  const [images, setImages] = useState<ImageRow[] | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    getPublishedAssetBySlug(slug).then((row) => {
      if (cancelled) return
      if (!row) {
        setNotFound(true)
        return
      }
      setAsset(row)
      listPublishedImages(row.id).then((imgs) => {
        if (!cancelled) setImages(imgs)
      })
    })
    return () => {
      cancelled = true
    }
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
      <div className="mt-3 text-xs text-muted-foreground">
        {asset.image_count} Images · {asset.language_count} Languages
      </div>

      {images === null ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      ) : images.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          该资产暂无可见图片。
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => (
            <figure key={img.id} className="overflow-hidden rounded-lg border">
              <img
                src={toPublicUrl(img.storage_path)}
                alt={img.filename}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
              <figcaption className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                {img.filename}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
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
