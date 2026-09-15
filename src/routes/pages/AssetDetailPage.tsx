import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, CheckCheck, ChevronRight, Download, DownloadCloud, Image as ImageIcon, ListChecks, Lock, Tag as TagIcon } from 'lucide-react'
import {
  getPublishedAssetBySlug,
  imageSrcOf,
  listImagesByLanguage,
  listPublishedLanguages,
  THUMB_GRID,
  type ImageVariant,
} from '@/features/assets/api'
import { listAssetTags } from '@/features/tags/api'
import { getPublished360 } from '@/features/assets360/api'
import { Spin360 } from '@/features/assets360/Spin360'
import { parseLanguageCode } from '@/lib/validators'
import { useLocale } from '@/i18n'
import type {
  AssetLanguageRow,
  ImageRow,
  LanguageCode,
  Published360Row,
  PublishedAssetRow,
  PublishedCollectionRow,
  TagRow,
} from '@/types/database'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import {
  DownloadError,
  downloadSingleImage,
  downloadZip,
  fetchMyCredits,
} from '@/features/downloads/api'
import { PackageDownloadPanel } from '@/features/downloads/PackageDownloadPanel'
import { getPublishedBreadcrumbById } from '@/features/collections/api'
import { getSiteSettings } from '@/features/settings/api'
import { Lightbox } from '@/components/Lightbox'
import { useToast } from '@/components/ToastProvider'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'
import { useBreadcrumb } from '@/components/Breadcrumbs'

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
  const { t } = useLocale()
  const { setLeafName } = useBreadcrumb()

  const [asset, setAsset] = useState<PublishedAssetRow | null>(null)
  const [languages, setLanguages] = useState<AssetLanguageRow[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [assetTags, setAssetTags] = useState<TagRow[]>([])

  const [imagesByLang, setImagesByLang] = useState<Record<string, ImageRow[]>>({})
  const [activeLang, setActiveLang] = useState<LanguageCode | null>(null)

  // V1.5 C：360° View（Asset 级能力，与语言完全解耦）
  //   undefined = 未加载；null = 该资产无启用序列 → 前台零渲染（规格 §30）
  const [spin360, setSpin360] = useState<Published360Row | null | undefined>(undefined)

  // PC-4：下载成本透出（settings 读，不写死；总纲 §58）
  const [costs, setCosts] = useState<{ single: number; zipPer: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    getSiteSettings()
      .then((s) => {
        if (!cancelled) setCosts({ single: s.single_image_download_cost, zipPer: s.zip_download_cost_per_image })
      })
      .catch(() => {
        if (!cancelled) setCosts({ single: 1, zipPer: 1 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // V1.3.1 G6：当前用户是否无限积分（成本标签显示 ♾ 而非扣分数字）
  const [unlimited, setUnlimited] = useState(false)
  useEffect(() => {
    let cancelled = false
    setUnlimited(false)
    if (!session) return
    fetchMyCredits()
      .then((v) => {
        if (!cancelled && v) setUnlimited(v.unlimited)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [session])

  // 下载 UI 状态
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // V1.6.0-B：预览 → V1.10 改为存「所属分组的图片列表 + 组内索引」。
  // 图库按 主副图 / A+ / 品牌故事 分组后，Lightbox 整组 ←/→ 只在点击所在分组内翻页；
  // null = 未打开。切语言时整个预览重置。
  const [preview, setPreview] = useState<{ images: ImageRow[]; index: number } | null>(null)
  const toast = useToast()

  // V1.4.2：资产所属合集面包屑链（探索 / 合集链… / 资产名）；链断裂或无合集 = 不渲染
  const [assetBreadcrumb, setAssetBreadcrumb] = useState<PublishedCollectionRow[]>([])
  useEffect(() => {
    let cancelled = false
    setAssetBreadcrumb([])
    const cid = asset?.collection_id
    if (!cid) return
    getPublishedBreadcrumbById(cid)
      .then((chain) => {
        if (!cancelled) setAssetBreadcrumb(chain)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [asset?.collection_id])

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
      setPreview(null)
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

  // 4b) 360° View（V1.5 C）：只按 asset.id 取一次——?lang= 变化不重取、不重置（实现不变量）
  useEffect(() => {
    if (!asset?.id) return
    let cancelled = false
    setSpin360(undefined)
    getPublished360(asset.id)
      .then((row) => {
        if (!cancelled) setSpin360(row && row.frames?.length ? row : null)
      })
      .catch(() => {
        // 360 读取失败不影响资产页其余能力（下载/图库/语言），按「无 360」静默处理
        if (!cancelled) setSpin360(null)
      })
    return () => {
      cancelled = true
    }
  }, [asset?.id])

  // 面包屑末级：资产加载完成后写入真实名称；路由切换/卸载时 cleanup 复位，避免名称串台
  useEffect(() => {
    setLeafName(asset?.name ?? null)
    return () => setLeafName(null)
  }, [asset?.name])

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

  // V1.10：按分类拆分当前语言图片（既有数据默认 main；A+ 再分桌面/移动两套）
  const allImgs = activeImages ?? []
  const mainImgs = allImgs.filter((i) => (i.category ?? 'main') === 'main')
  const brandImgs = allImgs.filter((i) => i.category === 'brand')
  const aplusDesktop = allImgs.filter((i) => i.category === 'aplus' && i.aplus_variant === 'desktop')
  const aplusMobile = allImgs.filter((i) => i.category === 'aplus' && i.aplus_variant === 'mobile')
  const aplusCount = aplusDesktop.length + aplusMobile.length

  const requireLogin = (): boolean => {
    if (!session) {
      toast.error(t('download.needLogin'))
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
      toast.error(e instanceof DownloadError ? e.message : t('download.downloadFailed'))
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
      toast.success(t('download.zipDone', { n: selected.size }))
      setSelected(new Set())
      setSelectionMode(false)
    } catch (e) {
      toast.error(e instanceof DownloadError ? e.message : t('download.zipFailed'))
    }
    setBusy(false)
  }

  const allSelected =
    !!activeImages && activeImages.length > 0 && activeImages.every((i) => selected.has(i.id))
  const handleSelectAll = () => {
    if (!activeImages) return
    if (allSelected) {
      setSelected(new Set())
      return
    }
    const ids = activeImages.map((i) => i.id).slice(0, MAX_ZIP)
    setSelected(new Set(ids))
  }

  // V1.10：单图成本标签（♾ 或 N 积分；未取到 settings 则 null）
  const singleCostLabel = costs ? (unlimited ? '♾' : t('credits.singleCost', { n: costs.single })) : null
  // 分组图卡共享的选择/下载/预览控制（ImageFigure 子组件消费）
  const figCtl: FigureCtl = {
    selectionMode,
    isSelected: (id) => selected.has(id),
    canSelectMore: selected.size < MAX_ZIP,
    busy,
    costLabel: singleCostLabel,
    onToggle: toggleSelect,
    onPreview: (group, index) => setPreview({ images: group, index }),
    onDownload: (img) => void onSingleDownload(img),
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
        {/* 主区：面包屑 + 标题 + 语言 Tab + 图库 */}
        <div className="min-w-0">
          {assetBreadcrumb.length > 0 && (
            <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumb">
              <Link to="/" className="hover:text-foreground hover:underline">
                {t('nav.explore')}
              </Link>
              {assetBreadcrumb.map((b) => (
                <span key={b.id} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5" />
                  <Link to={`/collection/${b.slug}`} className="hover:text-foreground hover:underline">
                    {b.name}
                  </Link>
                </span>
              ))}
              <span className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-foreground">{asset.name}</span>
              </span>
            </nav>
          )}
          <h1 className="text-3xl font-bold">{asset.name}</h1>
          {asset.description && (
            <p className="mt-2 max-w-2xl text-muted-foreground">{asset.description}</p>
          )}
          <div className="mt-3 text-xs text-muted-foreground">
            {asset.image_count} {t('asset.images')} · {asset.language_count} {t('asset.languages')}
          </div>

          {/* 标签（Asset 级，点击跳搜索结果） */}
          {assetTags.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
              {assetTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => navigate(`/search?tags=${encodeURIComponent(tag.slug)}`)}
                  className="rounded-full border border-input px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}

          {/* 360° View（V1.5 C）：Asset 级独立模块，位于普通 Gallery 之前、语言 Tab 之外；
              无启用序列 → 完全不渲染（规格 §30），文案永不出现帧数（规格 §9/§54） */}
          {spin360 && (
            <section className="mt-6" aria-label={t('asset.s360.sectionTitle')}>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">{t('asset.s360.sectionTitle')}</h2>
              <Spin360 frames={spin360.frames} />
            </section>
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
                {selectionMode ? t('asset.cancelSelection') : t('asset.selectForZip')}
              </Button>
              {selectionMode && (
                <Button size="sm" variant="outline" onClick={handleSelectAll}>
                  <CheckCheck className="mr-1 h-4 w-4" />
                  {allSelected ? t('asset.deselectAll') : t('asset.selectAll')}
                </Button>
              )}
              {!session && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> {t('asset.downloadNeedLogin')}
                </span>
              )}
            </div>
          )}

          {/* 图库（V1.10：主副图 → A+ → 品牌故事，分段带小标题；无该类则整段不渲染） */}
          {!activeImages ? (
            <div className="flex justify-center py-20">
              <Spinner className="h-6 w-6" />
            </div>
          ) : activeImages.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
              {t('asset.noImages')}
            </div>
          ) : (
            <div className="mt-6 space-y-10">
              {mainImgs.length > 0 && (
                <section aria-label={t('asset.catMain')}>
                  <SectionHeading>{t('asset.catMain')}</SectionHeading>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {mainImgs.map((img, idx) => (
                      <ImageFigure
                        key={img.id}
                        img={img}
                        index={idx}
                        group={mainImgs}
                        layout="grid"
                        variant={THUMB_GRID}
                        ctl={figCtl}
                      />
                    ))}
                  </div>
                </section>
              )}

              {aplusCount > 0 && (
                <section aria-label={t('asset.catAplus')}>
                  <SectionHeading>{t('asset.catAplus')}</SectionHeading>
                  {/* 桌面套：宽屏（≥lg）显示；移动套：窄屏显示。两套齐全时按屏切换，只有一套时常显 */}
                  {aplusDesktop.length > 0 && (
                    <div className={cn('flex flex-col', aplusMobile.length > 0 && 'hidden lg:flex')}>
                      {aplusDesktop.map((img, idx) => (
                        <ImageFigure
                          key={img.id}
                          img={img}
                          index={idx}
                          group={aplusDesktop}
                          layout="full"
                          variant={APLUS_DESKTOP_VARIANT}
                          ctl={figCtl}
                        />
                      ))}
                    </div>
                  )}
                  {aplusMobile.length > 0 && (
                    <div className={cn('flex flex-col', aplusDesktop.length > 0 && 'lg:hidden')}>
                      {aplusMobile.map((img, idx) => (
                        <ImageFigure
                          key={img.id}
                          img={img}
                          index={idx}
                          group={aplusMobile}
                          layout="full"
                          variant={APLUS_MOBILE_VARIANT}
                          ctl={figCtl}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}

              {brandImgs.length > 0 && (
                <section aria-label={t('asset.catBrand')}>
                  <SectionHeading>{t('asset.catBrand')}</SectionHeading>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {brandImgs.map((img, idx) => (
                      <ImageFigure
                        key={img.id}
                        img={img}
                        index={idx}
                        group={brandImgs}
                        layout="grid"
                        variant={THUMB_GRID}
                        ctl={figCtl}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* 侧栏：Package Download（与语言完全解耦） */}
        <aside className="lg:pt-1">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <DownloadCloud className="h-4 w-4" />
            {t('download.packageTitle')}
          </div>
          <PackageDownloadPanel assetId={asset.id} imageCount={asset.image_count} />
        </aside>
      </div>

      {/* 底部浮条：ZIP 选择汇总 */}
      {selectionMode && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm font-medium">
              {t('download.zipSelected', { n: selected.size })}
            {costs && (
              <span className="ml-2 text-muted-foreground">
                · {unlimited ? `♾ ${t('credits.unlimited')}` : t('credits.zipCost', { n: selected.size * costs.zipPer })}
              </span>
            )}
              {selected.size >= MAX_ZIP && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('download.zipLimitReached', { max: MAX_ZIP })}
                </span>
              )}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
                {t('common.clear')}
              </Button>
              <Button size="sm" disabled={busy} onClick={onZipDownload}>
                {busy ? <Spinner className="h-4 w-4" /> : <Download className="mr-1 h-4 w-4" />}
                {t('download.downloadSelected')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏预览（V1.6.0-B 整组翻页；V1.10 索引绑定「点击所在分组」的图片列表） */}
      {preview && preview.images.length > 0 && (
        <Lightbox
          images={preview.images}
          index={preview.index < preview.images.length ? preview.index : 0}
          onIndexChange={(index) => setPreview((p) => (p ? { ...p, index } : p))}
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
  const { t } = useLocale()
  return (
    <div className="mx-auto max-w-7xl px-4 py-24 text-center sm:px-6">
      <h1 className="text-2xl font-semibold">{t('errors.assetNotFound')}</h1>
      <p className="mt-2 text-muted-foreground">{t('errors.assetNotFoundHint')}</p>
    </div>
  )
}

/** A+ 两套目标尺寸的原生宽缩略（github 分支按宽缩放、保比例；quality 85 偏清晰） */
const APLUS_DESKTOP_VARIANT: ImageVariant = { width: 1464, height: 600, quality: 85 }
const APLUS_MOBILE_VARIANT: ImageVariant = { width: 600, height: 450, quality: 85 }

/** 分段小标题：与 360° 区同款弱化的次要色，做到「有分隔但不突兀」 */
function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-medium text-muted-foreground">{children}</h2>
}

/** 分组图卡共享的选择/下载/预览控制（由页面注入，避免逐卡 prop 爆炸） */
interface FigureCtl {
  selectionMode: boolean
  isSelected: (id: string) => boolean
  canSelectMore: boolean
  busy: boolean
  costLabel: string | null
  onToggle: (id: string) => void
  onPreview: (group: ImageRow[], index: number) => void
  onDownload: (img: ImageRow) => void
}

/**
 * 单张图卡（V1.10）。
 *  - layout='grid'：主副图 / 品牌故事，方形裁剪缩略 + 圆角描边 + 文件名，视觉与原网格逐字节一致。
 *  - layout='full'：A+，整宽、按原比例、上下无缝堆叠（去描边/圆角/文件名）。
 */
function ImageFigure({
  img,
  index,
  group,
  layout,
  variant,
  ctl,
}: {
  img: ImageRow
  index: number
  group: ImageRow[]
  layout: 'grid' | 'full'
  variant: ImageVariant
  ctl: FigureCtl
}) {
  const { t } = useLocale()
  const isSelected = ctl.isSelected(img.id)
  const selectDisabled = !isSelected && !ctl.canSelectMore
  return (
    <figure
      className={cn(
        'group relative',
        layout === 'grid' && 'overflow-hidden rounded-lg border',
        isSelected && 'ring-2 ring-primary',
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (ctl.selectionMode) {
            if (!selectDisabled) ctl.onToggle(img.id)
          } else {
            ctl.onPreview(group, index)
          }
        }}
        className={cn('block w-full', ctl.selectionMode ? 'cursor-pointer' : 'cursor-zoom-in')}
        aria-label={
          ctl.selectionMode
            ? isSelected
              ? t('asset.deselect')
              : t('asset.select')
            : t('asset.preview', { name: img.filename })
        }
      >
        <img
          src={imageSrcOf(img, variant)}
          alt={img.filename}
          loading="lazy"
          decoding="async"
          className={
            layout === 'grid'
              ? 'aspect-square w-full object-cover'
              : 'block h-auto w-full object-cover'
          }
        />
      </button>
      {/* 选择框（选择模式下） */}
      {ctl.selectionMode && (
        <button
          type="button"
          onClick={() => ctl.onToggle(img.id)}
          disabled={selectDisabled}
          aria-label={isSelected ? t('asset.deselect') : t('asset.select')}
          className={cn(
            'absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-background/90',
            isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground',
            selectDisabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {isSelected && <Check className="h-4 w-4" />}
        </button>
      )}
      {/* 单图下载（非选择模式时 hover 显示；成本透出 ♾/N 积分） */}
      {!ctl.selectionMode && (
        <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {ctl.costLabel && (
            <span className="rounded-full bg-background/90 px-2 py-0.5 text-xs shadow">{ctl.costLabel}</span>
          )}
          <button
            type="button"
            onClick={() => ctl.onDownload(img)}
            aria-label={t('asset.download')}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-background/90 shadow"
          >
            {ctl.busy ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          </button>
        </div>
      )}
      {layout === 'grid' && (
        <figcaption className="flex items-center gap-1 truncate px-2 py-1.5 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{img.filename}</span>
        </figcaption>
      )}
    </figure>
  )
}
