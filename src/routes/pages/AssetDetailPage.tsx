import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  getPublishedAssetBySlug,
  listImagesByLanguage,
  listPublishedLanguages,
  toPublicUrl,
} from '@/features/assets/api'
import { parseLanguageCode } from '@/lib/validators'
import type { AssetLanguageRow, ImageRow, LanguageCode, PublishedAssetRow } from '@/types/database'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

/**
 * 用户端 Asset 详情（Phase 4 · 多语言浏览）：
 * - 语言 Tab 只列 published 语言（RLS 双层过滤：asset+language 均 published）
 * - 固定产品顺序 EN→DE→IT→FR→ES
 * - 默认选中：en 若存在，否则第一个 published 语言
 * - ?lang 仅接受小写白名单；无效/draft 静默回退默认，并 replaceState 规范化
 * - 切换只替换 Image Grid，不重载 Asset
 * 下载三件套属 Phase 5 —— 本页只做浏览。
 */
export function AssetDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchParams, setSearchParams] = useSearchParams()

  const [asset, setAsset] = useState<PublishedAssetRow | null>(null)
  const [languages, setLanguages] = useState<AssetLanguageRow[] | null>(null)
  const [notFound, setNotFound] = useState(false)

  // 图片按语言缓存，切换命中缓存则不重复请求
  const [imagesByLang, setImagesByLang] = useState<Record<string, ImageRow[]>>({})
  const [activeLang, setActiveLang] = useState<LanguageCode | null>(null)

  // 1) 载入资产 + published 语言（固定顺序）
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
      listPublishedLanguages(row.id).then((langs) => {
        if (cancelled) return
        const ordered = LANGUAGE_CODES.map((code) => langs.find((l) => l.language_code === code)).filter(
          (l): l is AssetLanguageRow => !!l,
        )
        setLanguages(ordered)
      })
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  // published 语言 code 集合（用于校验 ?lang）
  const publishedCodes = useMemo<Set<string>>(
    () => new Set((languages ?? []).map((l) => l.language_code as string)),
    [languages],
  )

  // 有效语言：?lang 命中 published 集合则用之，否则回退（en 优先，否则第一个）
  const effectiveLang = useMemo<LanguageCode | null>(() => {
    if (!languages || languages.length === 0) return null
    const requested = parseLanguageCode(searchParams.get('lang'))
    if (requested && publishedCodes.has(requested)) return requested as LanguageCode
    if (publishedCodes.has('en')) return 'en'
    return languages[0].language_code
  }, [languages, searchParams, publishedCodes])

  // 2) 规范化 URL：把 effective 语言写回 ?lang（replaceState，不新增历史）
  useEffect(() => {
    if (!effectiveLang) return
    if (searchParams.get('lang') !== effectiveLang) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('lang', effectiveLang)
          return next
        },
        { replace: true },
      )
    }
  }, [effectiveLang, searchParams, setSearchParams])

  // 3) 同步 activeLang 并确保其图片已加载
  useEffect(() => {
    if (!effectiveLang) return
    setActiveLang(effectiveLang)
    if (!imagesByLang[effectiveLang]) {
      const langRow = languages?.find((l) => l.language_code === effectiveLang)
      if (langRow) {
        listImagesByLanguage(langRow.id).then((imgs) =>
          setImagesByLang((prev) => ({ ...prev, [effectiveLang]: imgs })),
        )
      }
    }
  }, [effectiveLang, languages, imagesByLang])

  if (notFound) return <NotFoundInline />
  if (!asset || languages === null) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  const activeImages = activeLang ? imagesByLang[activeLang] : undefined

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold">{asset.name}</h1>
      {asset.description && (
        <p className="mt-2 max-w-2xl text-muted-foreground">{asset.description}</p>
      )}
      <div className="mt-3 text-xs text-muted-foreground">
        {asset.image_count} Images · {asset.language_count} Languages
      </div>

      {/* 语言 Tab 条：只列 published，固定 EN→DE→IT→FR→ES */}
      {languages.length > 1 && (
        <div className="mt-6 flex flex-wrap gap-1 border-b">
          {languages.map((lang) => {
            const isActive = lang.language_code === activeLang
            return (
              <button
                key={lang.language_code}
                type="button"
                onClick={() => {
                  setActiveLang(lang.language_code)
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev)
                      next.set('lang', lang.language_code)
                      return next
                    },
                    { replace: true },
                  )
                }}
                className={cn(
                  '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {LANGUAGE_LABELS[lang.language_code]}
              </button>
            )
          })}
        </div>
      )}

      {/* Image Grid：仅替换当前语言数据 */}
      {!activeImages ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6" />
        </div>
      ) : activeImages.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          该语言暂无图片。
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {activeImages.map((img) => (
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
