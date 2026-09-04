import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, Download, DownloadCloud, Image as ImageIcon, ListChecks, Lock, Tag as TagIcon } from 'lucide-react'
import {
  getPublishedAssetBySlug,
  imageSrcOf,
  listImagesByLanguage,
  listPublishedLanguages,
  THUMB_GRID,
} from '@/features/assets/api'
import { listAssetTags } from '@/features/tags/api'
import { parseLanguageCode } from '@/lib/validators'
import type {
  AssetLanguageRow,
  ImageRow,
  LanguageCode,
  PublishedAssetRow,
  TagRow,
} from '@/types/database'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import {
  DownloadError,
  downloadSingleImage,
  downloadZip,
} from '@/features/downloads/api'
import { PackageDownloadPanel } from '@/features/downloads/PackageDownloadPanel'
import { Lightbox } from '@/components/Lightbox'
import { useToast } from '@/components/ToastProvider'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

const MAX_ZIP = 30

/**
 * 用户端 Asset 详情（Phase 4 多语言 + Phase 5 下载）。
 * 下载三件套彼此独立、与语言 Tab 解耦：
 *  - 单图 / ZIP 绑定「当前语言」的 asset_language_id
 *  - Package（网盘）只按 assetId 订阅，不接收语言 state
 */
export function AssetDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { session } = useAuth()

  const [asset, setAsset] = useState<PublishedAssetRow | null>(null)
  const [languages, setLanguages] = useState<AssetLanguageRow[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [assetTags, setAssetTags] = useState<TagRow[]>([])

  const [imagesByLang, setImagesByLang] = useState<Record<string, ImageRow[]>>({})
  const [activeLang, setActiveLang] = useState<LanguageCode | null>(null)

  // 下载 UI 状态
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ImageRow | null>(null)
  const toast = useToast()

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

  const publishedCodes = useMemo<Set<string>>(
    () => new Set((languages ?? []).map((l) => l.language_code as string)),
    [languages],
  )

  const effectiveLang = useMemo<LanguageCode | null>(() => {
    if (!languages || languages.length === 0) return null
    const requested = parseLanguageCode(searchParams.get('lang'))
    if (requested && publishedCodes.has(requested)) return requested as LanguageCode
    if (publishedCodes.has('en')) return 'en'
    return languages[0].language_code
  }, [languages, searchParams, publishedCodes])

  // 2) 规范化 ?lang
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

  // 3) 切语言 → 清空选择（禁止跨语言混选）+ 确保图片加载
  useEffect(() => {
    if (!effectiveLang) return
    if (activeLang !== effectiveLang) {
      setActiveLang(effectiveLang)
      setSelected(new Set())
    }
    if (!imagesByLang[effectiveLang]) {
      const langRow = languages?.find((l) => l.language_code === effectiveLang)
      if (langRow) {
        listImagesByLanguage(langRow.id).then((imgs) =>
          setImagesByLang((prev) => ({ ...prev, [effectiveLang]: imgs })),
        )
      }
    }
  }, [effectiveLang, activeLang, languages, imagesByLang])

  // 4) 载入该资产的标签（含 slug，供可点击筛选）
  useEffect(() => {
    if (!asset?.id) return
    let cancelled = false
    listAssetTags(asset.id).then((tags) => {
      if (!cancelled) setAssetTags(tags)
    })
    return () => {
      cancelled = true
    }
  }, [asset?.id])

  if (notFound) return <NotFoundInline />
  if (!asset || languages === null) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  const activeImages = activeLang ? imagesByLang[activeLang] : undefined
  const activeLangRow = languages.find((l) => l.language_code === activeLang) ?? null

  const requireLogin = (): boolean => {
    if (!session) {
      toast.error('请先登录后下载')
      return true
    }
    return false
  }

  const onSingleDownload = async (img: ImageRow) => {
    if (requireLogin()) return
    setBusy(true)
    try {
      await downloadSingleImage(img.id, img.filename)
    } catch (e) {
      toast.error(e instanceof DownloadError ? e.message : '下载失败')
    }
    setBusy(false)
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_ZIP) next.add(id)
      return next
    })
  }

  const onZipDownload = async () => {
    if (requireLogin()) return
    if (!activeLangRow || selected.size === 0) return
    setBusy(true)
    try {
      await downloadZip(activeLangRow.id, Array.from(selected), `${asset.slug}-${activeLang}.zip`)
      toast.success(`已打包 ${selected.size} 张`)
      setSelected(new Set())
      setSelectionMode(false)
    } catch (e) {
      toast.error(e instanceof DownloadError ? e.message : '打包失败')
    }
    setBusy(false)
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
        {/* 主区：标题 + 语言 Tab + 图库 */}
        <div className="min-w-0">
          <h1 className="text-3xl font-bold">{asset.name}</h1>
          {asset.description && (
            <p className="mt-2 max-w-2xl text-muted-foreground">{asset.description}</p>
          )}
          <div className="mt-3 text-xs text-muted-foreground">
            {asset.image_count} Images · {asset.language_count} Languages
          </div>

          {/* 标签（Asset 级，点击跳搜索结果） */}
          {assetTags.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
              {assetTags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate(`/search?tags=${encodeURIComponent(t.slug)}`)}
                  className="rounded-full border border-input px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}

          {/* 语言 Tab 条 */}
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

          {/* 选择模式工具条 */}
          {activeImages && activeImages.length > 0 && (
            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                variant={selectionMode ? 'default' : 'outline'}
                onClick={() => {
                  setSelectionMode((v) => !v)
                  setSelected(new Set())
                }}
              >
                <ListChecks className="mr-1 h-4 w-4" />
                {selectionMode ? 'Cancel selection' : 'Select for ZIP'}
              </Button>
              {!session && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> 下载需登录
                </span>
              )}
            </div>
          )}

          {/* Image Grid */}
          {!activeImages ? (
            <div className="flex justify-center py-20">
              <Spinner className="h-6 w-6" />
            </div>
          ) : activeImages.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
              该语言暂无图片。
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {activeImages.map((img) => {
                const isSelected = selected.has(img.id)
                const selectDisabled = !isSelected && selected.size >= MAX_ZIP
                return (
                  <figure
                    key={img.id}
                    className={cn(
                      'group relative overflow-hidden rounded-lg border',
                      isSelected && 'ring-2 ring-primary',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => !selectionMode && setPreview(img)}
                      className="block w-full cursor-zoom-in"
                      aria-label={`Preview ${img.filename}`}
                    >
                      <img
                        src={imageSrcOf(img, THUMB_GRID)}
                        alt={img.filename}
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    </button>
                    {/* 选择框（选择模式下） */}
                    {selectionMode && (
                      <button
                        type="button"
                        onClick={() => toggleSelect(img.id)}
                        disabled={selectDisabled}
                        aria-label={isSelected ? 'Deselect' : 'Select'}
                        className={cn(
                          'absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-background/90',
                          isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground',
                          selectDisabled && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        {isSelected && <Check className="h-4 w-4" />}
                      </button>
                    )}
                    {/* 单图下载（非选择模式时 hover 显示） */}
                    {!selectionMode && (
                      <button
                        type="button"
                        onClick={() => onSingleDownload(img)}
                        aria-label="Download image"
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-background/90 shadow opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        {busy ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                      </button>
                    )}
                    <figcaption className="flex items-center gap-1 truncate px-2 py-1.5 text-xs text-muted-foreground">
                      <ImageIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{img.filename}</span>
                    </figcaption>
                  </figure>
                )
              })}
            </div>
          )}
        </div>

        {/* 侧栏：Package Download（与语言完全解耦） */}
        <aside className="lg:pt-1">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <DownloadCloud className="h-4 w-4" />
            Package Download
          </div>
          <PackageDownloadPanel assetId={asset.id} />
        </aside>
      </div>

      {/* 底部浮条：ZIP 选择汇总 */}
      {selectionMode && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm font-medium">
              {selected.size} selected
              {selected.size >= MAX_ZIP && (
                <span className="ml-2 text-xs text-muted-foreground">（已达上限 {MAX_ZIP}）</span>
              )}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" disabled={busy} onClick={onZipDownload}>
                {busy ? <Spinner className="h-4 w-4" /> : <Download className="mr-1 h-4 w-4" />}
                Download Selected
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏预览（Phase 9 D7） */}
      {preview && (
        <Lightbox
          image={preview}
          onClose={() => setPreview(null)}
          onDownload={(img) => {
            setPreview(null)
            onSingleDownload(img)
          }}
        />
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
