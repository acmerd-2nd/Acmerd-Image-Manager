import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2, X } from 'lucide-react'
import type {
  AssetLanguageRow,
  AssetRow,
  AssetStatus,
  ImageRow,
  LanguageCode,
  TagRow,
} from '@/types/database'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import {
  createLanguage,
  deleteAsset,
  deleteImageRow,
  deleteLanguage,
  getAsset,
  listImages,
  listLanguages,
  setLanguageStatus,
  swapImageOrder,
  toPublicUrl,
  transitionAsset,
  updateAsset,
} from '@/features/assets/api'
import { deleteGithubImage, uploadImageGithub } from '@/features/assets/github'
import {
  addAssetTag,
  createTag,
  listAssetTagIds,
  listTags,
  removeAssetTag,
} from '@/features/tags/api'
import { ALLOWED_MIME, MAX_FILE_SIZE, deleteStoragePaths } from '@/features/assets/storage'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'

/**
 * Asset 编辑器（Phase 3 核心工作台）：
 * 基础信息 / 语言面板（上传·排序·删图·Set Cover·语言 Publish）/
 * 顶部动作条（Publish·Unpublish·Archive·Restore·Delete）
 * 排序 V1 用上移/下移（拖拽留待 Phase 9 UX）。
 */
export function AdminAssetEditorPage() {
  const { t } = useLocale()
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [asset, setAsset] = useState<AssetRow | null>(null)
  const [languages, setLanguages] = useState<AssetLanguageRow[]>([])
  const [images, setImages] = useState<ImageRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<LanguageCode | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 基础信息草稿
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')

  // 标签（Phase 6）
  const [allTags, setAllTags] = useState<TagRow[]>([])
  const [assetTagIds, setAssetTagIds] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadLangRef = useRef<LanguageCode | null>(null)

  const reload = useCallback(async () => {
    try {
      const a = await getAsset(id)
      if (!a) {
        setLoadError(t('admin.editor.notExist'))
        return
      }
      setAsset(a)
      setName(a.name)
      setSlug(a.slug)
      setDescription(a.description ?? '')
      const [langs, imgs, tags, tagIds] = await Promise.all([
        listLanguages(id),
        listImages(id),
        listTags(),
        listAssetTagIds(id),
      ])
      setLanguages(langs)
      setImages(imgs)
      setAllTags(tags)
      setAssetTagIds(new Set(tagIds))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [id])

  useEffect(() => {
    reload()
  }, [reload])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/assets">Back to Assets</Link>
        </Button>
      </div>
    )
  }
  if (!asset) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  const imagesOf = (langId: string) => images.filter((i) => i.asset_language_id === langId)
  const missingLangs = LANGUAGE_CODES.filter((c) => !languages.some((l) => l.language_code === c))

  // ---------- 基础信息 ----------
  const saveBasics = () =>
    run(async () => {
      if (!name.trim()) throw new Error(t('admin.editor.nameRequiredShort'))
      await updateAsset(asset.id, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
      })
    })

  // ---------- 状态迁移 ----------
  const doTransition = (to: AssetStatus) =>
    run(async () => {
      // Publish 前客户端先校验一次（服务端 DB 触发器是终审）
      if (to === 'published') {
        const ok = languages.some(
          (l) => l.status === 'published' && imagesOf(l.id).length > 0,
        )
        if (!ok) throw new Error(t('admin.editor.publishBlockedMsg'))
      }
      await transitionAsset(asset.id, to)
    })

  const doDelete = () =>
    run(async () => {
      // V1.1 PB-1: GitHub 行必须先经 Worker 四态闭环删远端（DB 级联前删，
      // 否则行没了 sweeper 无法追踪远端对象）；supabase 行维持原兜底。
      const githubImgs = images.filter((i) => i.provider === 'github')
      for (const img of githubImgs) {
        await deleteGithubImage(img.id).catch(() => {
          setNotice(t('admin.editor.githubCleanupPending', { name: img.filename }))
        })
      }
      const storagePaths = images
        .filter((i) => i.provider !== 'github' && i.storage_path)
        .map((i) => i.storage_path as string)
      await deleteAsset(asset.id)
      await deleteStoragePaths(storagePaths).catch(() => {
        // 孤儿对象仅告警（列表页已有同款兜底）
      })
      navigate('/admin/assets')
    })

  // ---------- 语言 ----------
  const addLanguage = (code: LanguageCode) => run(async () => void (await createLanguage(asset.id, code)))

  const removeLanguage = (lang: AssetLanguageRow) =>
    run(async () => {
      if (imagesOf(lang.id).length > 0) throw new Error(t('admin.editor.langHasImages'))
      await deleteLanguage(lang.id)
    })

  const toggleLanguageStatus = (lang: AssetLanguageRow) =>
    run(() => setLanguageStatus(lang.id, lang.status === 'published' ? 'draft' : 'published'))

  // ---------- 图片 ----------
  const pickFiles = (lang: LanguageCode) => {
    uploadLangRef.current = lang
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const handleFilesChosen = async (files: FileList | null) => {
    const lang = uploadLangRef.current
    if (!files || files.length === 0 || !lang) return
    setBusy(true)
    setActionError(null)
    setNotice(null)
    setUploading(lang)

    try {
      const langRow = languages.find((l) => l.language_code === lang)
      if (!langRow) throw new Error(t('admin.editor.langMissing'))
      const fileList = Array.from(files ?? [])
      let count = 0

      for (const file of fileList) {
        if (file.size > MAX_FILE_SIZE) throw new Error(t('admin.editor.fileTooLarge', { name: file.name }))
        if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
          throw new Error(t('admin.editor.badFormat', { name: file.name }))
        }
        // V1.1 PB-1: 经 Worker 上传 GitHub（租约串行 + pending 态 + sha 校验 + ready）
        await uploadImageGithub(langRow.id, file)
        count += 1
      }
      setNotice(t('admin.editor.uploaded', { n: count, lang: LANGUAGE_LABELS[lang] }))
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
    setUploading(null)
    setBusy(false)
  }

  const moveImage = (img: ImageRow, dir: -1 | 1) =>
    run(async () => {
      const siblings = imagesOf(img.asset_language_id).sort((a, b) => a.sort_order - b.sort_order)
      const idx = siblings.findIndex((s) => s.id === img.id)
      const target = siblings[idx + dir]
      if (!target) return
      await swapImageOrder(img, target)
    })

  const removeImage = (img: ImageRow) =>
    run(async () => {
      if (img.provider === 'github') {
        // 四态闭环：远端删除成功才物理删行；远端失败保留 deleting 由 sweeper 收敛
        try {
          await deleteGithubImage(img.id)
        } catch (e) {
          if ((e as Error & { code?: string }).code === 'not_deletable') {
            await deleteImageRow(img.id) // failed 等无远端对象态 → 仅清行
          } else {
            setNotice(t('admin.editor.remoteDeletePending'))
          }
          return
        }
        return
      }
      await deleteImageRow(img.id) // 先删行（触发 image.deleted 审计；若为封面 FK 自动置 null）
      if (img.storage_path) {
        await deleteStoragePaths([img.storage_path]).catch((e) => {
          setNotice(t('admin.editor.rowDeletedCleanupFailed', { msg: e instanceof Error ? e.message : String(e) }))
        })
      }
    })

  const setCover = (img: ImageRow) =>
    run(async () => {
      await updateAsset(asset.id, { cover_image_id: img.id })
    })

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_MIME.join(',')}
        multiple
        className="hidden"
        onChange={(e) => handleFilesChosen(e.target.files)}
      />

      {/* 顶部动作条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">{asset.name}</h1>
        <StatusBadge status={asset.status} />
        {asset.status !== 'published' && (
          <Button size="sm" disabled={busy} onClick={() => doTransition('published')}>
            {t('admin.action.publish')}
          </Button>
        )}
        {asset.status === 'published' && (
          <>
            <Button asChild size="sm" variant="outline">
              <Link to={`/asset/${asset.slug}`} target="_blank">
                {t('admin.editor.preview')}
              </Link>
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => doTransition('draft')}>
              {t('admin.action.unpublish')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => doTransition('archived')}>
              {t('admin.action.archive')}
            </Button>
          </>
        )}
        {asset.status === 'archived' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => doTransition('draft')}
            title={t('admin.editor.publishHint')}
          >
            Restore
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
          {t('admin.action.delete')}
        </Button>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700">
          {notice}
        </div>
      )}

      {/* 基础信息 */}
      <section className="max-w-xl space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('admin.editor.basics')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('admin.editor.name')}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('admin.editor.slug')}</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t('admin.editor.description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={saveBasics}>
          {t('admin.editor.saveBasics')}
        </Button>
      </section>

      {/* 标签（Asset 级，Phase 6） */}
      <section className="max-w-xl space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('admin.editor.tagsSection')}</h2>

        {/* 已关联标签 */}
        <div className="flex flex-wrap gap-1.5">
          {allTags
            .filter((tg) => assetTagIds.has(tg.id))
            .map((tg) => (
              <span
                key={tg.id}
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs"
              >
                {tg.name}
                <button
                  type="button"
                  aria-label={t('admin.tags.removeTag', { name: tg.name })}
                  disabled={busy}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    run(async () => {
                      await removeAssetTag(asset.id, tg.id)
                    })
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          {assetTagIds.size === 0 && (
            <span className="text-xs text-muted-foreground">{t('admin.tags.none')}</span>
          )}
        </div>

        {/* 添加：过滤现有 + 快速新建 */}
        <div className="space-y-2">
          <Input
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            placeholder={t("admin.tags.searchOrCreate")}
          />
          <div className="flex flex-wrap gap-1.5">
            {allTags
              .filter(
                (t) =>
                  !assetTagIds.has(t.id) &&
                  t.name.toLowerCase().includes(tagFilter.trim().toLowerCase()),
              )
              .slice(0, 12)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await addAssetTag(asset.id, t.id)
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-full border border-input px-2.5 py-0.5 text-xs hover:bg-accent"
                >
                  <Plus className="h-3 w-3" />
                  {t.name}
                </button>
              ))}
          </div>
          {tagFilter.trim() &&
            !allTags.some((t) => t.name.toLowerCase() === tagFilter.trim().toLowerCase()) && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const created = await createTag(tagFilter.trim())
                    await addAssetTag(asset.id, created.id)
                    setTagFilter('')
                  })
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                {t('admin.tags.createAndLink', { name: tagFilter.trim() })}
              </Button>
            )}
        </div>
      </section>

      {/* 语言面板 */}
      <section className="space-y-4">
        <h2 className="font-medium">{t('admin.editor.languages')}</h2>

        {/* 状态总览：固定产品顺序，一眼看清哪些语言对用户可见 */}
        {languages.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {LANGUAGE_CODES.map((code) => {
              const lang = languages.find((l) => l.language_code === code)
              if (!lang) return null
              const count = imagesOf(lang.id).length
              const visible = lang.status === 'published' && asset.status === 'published' && count > 0
              return (
                <span
                  key={code}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                    visible
                      ? 'border-green-600/40 bg-green-600/10 text-green-700'
                      : 'border-muted-foreground/30 text-muted-foreground',
                  )}
                  title={visible ? t('admin.editor.langVisibleTitle') : t('admin.editor.langHiddenTitle')}
                >
                  <span className="font-medium">{LANGUAGE_LABELS[code]}</span>
                  <span>· {t('admin.editor.langImgs', { n: count })}</span>
                  <span>· {lang.status}</span>
                  {visible && <span>✓</span>}
                </span>
              )
            })}
          </div>
        )}

        {languages.map((lang) => {
          const imgs = imagesOf(lang.id).sort((a, b) => a.sort_order - b.sort_order)
          return (
            <div key={lang.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{LANGUAGE_LABELS[lang.language_code]}</span>
                <Badge variant={lang.status === 'published' ? 'default' : 'secondary'}>
                  {lang.status}
                </Badge>
                <span className="text-xs text-muted-foreground">{imgs.length} images</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => pickFiles(lang.language_code)}>
                    <ImagePlus className="mr-1 h-4 w-4" />
                    {uploading === lang.language_code ? t('admin.editor.uploading') : t('admin.editor.upload')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => toggleLanguageStatus(lang)}
                  >
                    {lang.status === 'published' ? t('admin.editor.toDraft') : t('admin.editor.publishLang')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || imgs.length > 0}
                    title={imgs.length > 0 ? t('admin.editor.deleteLangDisabled') : t('admin.editor.deleteLang')}
                    onClick={() => removeLanguage(lang)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {imgs.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('admin.editor.noImages')}</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {imgs.map((img, idx) => (
                    <div key={img.id} className="space-y-1 rounded border p-1">
                      <div className="relative aspect-square overflow-hidden rounded bg-muted">
                        <img src={toPublicUrl(img)} alt={img.filename} className="h-full w-full object-cover" />
                        {asset.cover_image_id === img.id && (
                          <span className="absolute left-1 top-1 rounded bg-primary px-1 text-[10px] text-primary-foreground">
                            {t('admin.editor.cover')}
                          </span>
                        )}
                      </div>
                      <div className="flex justify-center gap-0.5">
                        <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy || idx === 0} onClick={() => moveImage(img, -1)} title={t('admin.editor.moveUp')}>
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy || idx === imgs.length - 1} onClick={() => moveImage(img, 1)} title={t('admin.editor.moveDown')}>
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-1.5 text-[11px]"
                          disabled={busy || asset.cover_image_id === img.id}
                          onClick={() => setCover(img)}
                        >
                          {t('admin.editor.setCover')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" disabled={busy} onClick={() => removeImage(img)} title={t('admin.editor.deleteImage')}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {missingLangs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-4">
            <span className="text-sm text-muted-foreground">{t('admin.editor.addLanguage')}</span>
            {missingLangs.map((c) => (
              <Button key={c} size="sm" variant="outline" disabled={busy} onClick={() => addLanguage(c)}>
                + {LANGUAGE_LABELS[c]}
              </Button>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete「${asset.name}」？`}
        destructive
        confirmLabel="Delete permanently"
        description={t('admin.editor.deleteBody', { langs: languages.length, images: images.length })}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={doDelete}
      />
    </div>
  )
}

function StatusBadge({ status }: { status: AssetStatus }) {
  const map: Record<AssetStatus, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
    draft: { label: 'Draft', variant: 'secondary' },
    published: { label: 'Published', variant: 'default' },
    archived: { label: 'Archived', variant: 'outline' },
  }
  const b = map[status]
  return <Badge variant={b.variant}>{b.label}</Badge>
}
