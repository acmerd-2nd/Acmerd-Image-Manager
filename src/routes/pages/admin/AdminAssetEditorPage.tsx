import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, ImagePlus, Trash2 } from 'lucide-react'
import type {
  AssetLanguageRow,
  AssetRow,
  AssetStatus,
  ImageRow,
  LanguageCode,
} from '@/types/database'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import {
  createImageRow,
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
import { ALLOWED_MIME, MAX_FILE_SIZE, deleteStoragePaths, uploadImage } from '@/features/assets/storage'
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

  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadLangRef = useRef<LanguageCode | null>(null)

  const reload = useCallback(async () => {
    try {
      const a = await getAsset(id)
      if (!a) {
        setLoadError('Asset 不存在或无权访问')
        return
      }
      setAsset(a)
      setName(a.name)
      setSlug(a.slug)
      setDescription(a.description ?? '')
      const [langs, imgs] = await Promise.all([listLanguages(id), listImages(id)])
      setLanguages(langs)
      setImages(imgs)
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
      if (!name.trim()) throw new Error('Name 不能为空')
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
        if (!ok) throw new Error('PUBLISH_BLOCKED：需要至少 1 个含图片的 published 语言版本')
      }
      await transitionAsset(asset.id, to)
    })

  const doDelete = () =>
    run(async () => {
      const paths = images.map((i) => i.storage_path)
      await deleteAsset(asset.id)
      await deleteStoragePaths(paths).catch(() => {
        // 孤儿对象仅告警（列表页已有同款兜底）
      })
      navigate('/admin/assets')
    })

  // ---------- 语言 ----------
  const addLanguage = (code: LanguageCode) => run(async () => void (await createLanguage(asset.id, code)))

  const removeLanguage = (lang: AssetLanguageRow) =>
    run(async () => {
      if (imagesOf(lang.id).length > 0) throw new Error('该语言下仍有图片，先清空再删除')
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
      if (!langRow) throw new Error('语言不存在')
      const existing = imagesOf(langRow.id)
      let seq = existing.length
      const uploadedPaths: string[] = []

      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_SIZE) throw new Error(`文件过大：${file.name}（上限 15 MB）`)
        if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
          throw new Error(`不支持的格式：${file.name}（仅 JPEG/PNG/WebP）`)
        }
        seq += 1
        const path = await uploadImage(asset.id, lang, seq, file)
        uploadedPaths.push(path)
        try {
          await createImageRow({
            asset_language_id: langRow.id,
            filename: file.name,
            storage_path: path,
            mime_type: file.type,
            file_size: file.size,
            sort_order: seq,
          })
        } catch (rowErr) {
          // DB 行失败 → 立即清理已传对象，防孤儿
          await deleteStoragePaths([path]).catch(() => {})
          throw rowErr
        }
      }
      setNotice(`已上传 ${uploadedPaths.length} 张图到 ${LANGUAGE_LABELS[lang]}`)
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
      await deleteImageRow(img.id) // 先删行（触发 image.deleted 审计；若为封面 FK 自动置 null）
      await deleteStoragePaths([img.storage_path]).catch((e) => {
        setNotice(`图片记录已删，但存储对象清理失败：${e instanceof Error ? e.message : String(e)}`)
      })
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
            Publish
          </Button>
        )}
        {asset.status === 'published' && (
          <>
            <Button asChild size="sm" variant="outline">
              <Link to={`/asset/${asset.slug}`} target="_blank">
                Preview
              </Link>
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => doTransition('draft')}>
              Unpublish
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => doTransition('archived')}>
              Archive
            </Button>
          </>
        )}
        {asset.status === 'archived' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => doTransition('draft')}
            title="恢复为 Draft，重新检查后才能 Publish"
          >
            Restore
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
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
        <h2 className="font-medium">基础信息</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Slug</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={saveBasics}>
          Save basics
        </Button>
      </section>

      {/* 语言面板 */}
      <section className="space-y-4">
        <h2 className="font-medium">语言版本</h2>

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
                  title={visible ? '用户端可见' : '用户端不可见'}
                >
                  <span className="font-medium">{LANGUAGE_LABELS[code]}</span>
                  <span>· {count}图</span>
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
                    {uploading === lang.language_code ? '上传中…' : 'Upload'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => toggleLanguageStatus(lang)}
                  >
                    {lang.status === 'published' ? 'To Draft' : 'Publish lang'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || imgs.length > 0}
                    title={imgs.length > 0 ? '先清空图片才能删除语言' : '删除语言'}
                    onClick={() => removeLanguage(lang)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {imgs.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无图片，点击 Upload 上传。</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {imgs.map((img, idx) => (
                    <div key={img.id} className="space-y-1 rounded border p-1">
                      <div className="relative aspect-square overflow-hidden rounded bg-muted">
                        <img src={toPublicUrl(img.storage_path)} alt={img.filename} className="h-full w-full object-cover" />
                        {asset.cover_image_id === img.id && (
                          <span className="absolute left-1 top-1 rounded bg-primary px-1 text-[10px] text-primary-foreground">
                            Cover
                          </span>
                        )}
                      </div>
                      <div className="flex justify-center gap-0.5">
                        <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy || idx === 0} onClick={() => moveImage(img, -1)} title="上移">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy || idx === imgs.length - 1} onClick={() => moveImage(img, 1)} title="下移">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-1.5 text-[11px]"
                          disabled={busy || asset.cover_image_id === img.id}
                          onClick={() => setCover(img)}
                        >
                          Cover
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" disabled={busy} onClick={() => removeImage(img)} title="删除图片">
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
            <span className="text-sm text-muted-foreground">添加语言版本：</span>
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
        description={`此操作物理删除：\n· ${languages.length} 个语言版本 / ${images.length} 张图片记录（级联）\n· Storage 中 images/${asset.id}/ 全部对象\n\n不可撤销，审计记录 asset.deleted。`}
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
