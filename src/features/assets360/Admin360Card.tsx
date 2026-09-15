import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderUp, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Spin360 } from '@/features/assets360/Spin360'
import {
  FRAME_COUNTS,
  FRAME_MAX_SIZE,
  FRAME_MIME,
  Seq360ApiError,
  activateSequence,
  completeSequence,
  createSequence,
  deleteSequence,
  listMissingFrameIndices,
  listSequenceFrameSources,
  listSequences,
  removeActive360,
  uploadFrames,
  type Frame360Count,
  type Sequence360Summary,
} from '@/features/assets360/api'
import type { Frame360Source } from '@/lib/image-source'
import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * V1.5 B2：Admin Asset Editor 的「360° Product Preview」卡片。
 *
 * 产品语义（规格 §10/§44/§45，Gate §G5）：帧数是后台资源规格，只在后台出现
 * （Status / Frames 两行管理信息 + 上传时的密度轻提示）；前台永远只有一个 360° View。
 *
 * 关键约束：
 * - 客户端强校验（§12）：数量 ≠ 选定帧数、非白名单 MIME、单帧 > 5MB → 直接拒绝，不进上传；
 * - 帧序重编号（§13）：按文件名自然序（数字感知）排序后统一 1..N，DB 存 frame_index，播放不依赖文件名；
 * - 文件夹上传（V1.9.4）：可拖入整个文件夹 / 选择文件夹 / 多选文件；自动按文件名数字感知排序、
 *   重编号 1..N、过滤非图片与隐藏/系统文件、自动识别帧数（须命中 36/72/144/360 规格）；
 * - 逐帧串行上传（V1.9.4）：每帧一个独立小请求 + 逐帧进度 + 单帧最多重试 3 次 + 可中止续传
 *   （取代旧「≤20 帧/请求」——大批量会让 Worker 单次缓冲 ~100MB、进度只在批间刷新，观感「卡死」）；
 * - 先 Preview 再 Activate（§16/§17）：激活是单语句原子切换，旧序列保留到确认后再清理；
 * - Remove（§47）：active 序列不可直删 → 走「先下线指针」的移除路径，前台即时安全退出。
 */

const FRAME_HINTS: Record<Frame360Count, string> = {
  36: 'Basic',
  72: 'Standard',
  144: 'High Quality',
  360: 'Ultra Smooth',
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

/** 是否有效帧图片：MIME 命中白名单，或（文件夹场景 MIME 可能缺失）扩展名命中；排除隐藏/系统文件 */
function isImageFile(f: File): boolean {
  const name = f.name
  if (name.startsWith('.') || name.startsWith('._')) return false
  if (/(^|[\\/])(__MACOSX|[dD]s_[sS]tore)([\\/]|$)/.test((f as File & { webkitRelativePath?: string }).webkitRelativePath || '')) return false
  if (name.toLowerCase() === '.ds_store') return false
  const mimeOk = (FRAME_MIME as readonly string[]).includes(f.type)
  return mimeOk || IMAGE_EXT.test(name)
}

/** 过滤 + 数字感知排序（§13）：供「选择文件夹 / 多选 / 拖入」三种入口共用 */
function parseImageFiles(files: File[]): File[] {
  return files
    .filter(isImageFile)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

/** 从 DataTransfer 递归收集文件（支持拖入整个文件夹）；无目录项时回落 dt.files */
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : []
  const entries = items
    .map((it) => (typeof (it as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === 'function' ? (it as DataTransferItem & { webkitGetAsEntry: () => unknown }).webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e)
  if (entries.length === 0) return dt.files ? Array.from(dt.files) : []

  const out: File[] = []
  const fileFromEntry = (entry: FileSystemFileEntry) =>
    new Promise<void>((resolve) => entry.file((f) => { out.push(f); resolve() }, () => resolve()))
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') return
    if (entry.isFile) {
      await fileFromEntry(entry as unknown as FileSystemFileEntry)
    } else if (entry.isDirectory) {
      const reader = (entry as unknown as FileSystemDirectoryEntry).createReader()
      // readEntries 每次最多返回 100 项，需循环读到空
      let batch: FileSystemEntry[]
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])))
        for (const child of batch) await walk(child)
      } while (batch.length > 0)
    }
  }
  for (const e of entries) await walk(e)
  return out
}

interface UploadDraft {
  frameCount: Frame360Count
  files: File[] | null
}

export function Admin360Card({
  assetId,
  disabled,
  onAssetChanged,
}: {
  assetId: string
  disabled: boolean
  /** 激活/移除会改变 assets.active_360_sequence_id → 通知父级重读资产 */
  onAssetChanged: () => void
}) {
  const { t } = useLocale()
  const [sequences, setSequences] = useState<Sequence360Summary[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<UploadDraft | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /** 上传中断/部分失败时的续传锚点（同一序列，只补失败帧） */
  const [resume, setResume] = useState<{ sequenceId: string; indices: number[] } | null>(null)
  const [preview, setPreview] = useState<{ sequenceId: string; frames: Frame360Source[] } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<Sequence360Summary | null>(null)
  /** 行级补传：草稿丢失（刷新）后仍能给「上传中/失败且帧未齐」的序列续传 */
  const [resumeRow, setResumeRow] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const resumeInputRef = useRef<HTMLInputElement>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const draftRef = useRef<UploadDraft | null>(null)
  draftRef.current = draft

  const reload = useCallback(async () => {
    try {
      const r = await listSequences(assetId)
      setSequences(r.sequences)
      setActiveId(r.active_sequence_id)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [assetId])

  useEffect(() => {
    void reload()
  }, [reload])

  const errText = (e: unknown) => (e instanceof Seq360ApiError ? e.message : e instanceof Error ? e.message : String(e))

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
    await reload()
  }

  // ---------- 上传 ----------
  const openUpload = (frameCount: Frame360Count = 144) => {
    setError(null)
    setNotice(null)
    setResume(null)
    setProgress(null)
    setDraft({ frameCount, files: null })
  }

  const pickFiles = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const pickFolder = () => {
    if (folderInputRef.current) {
      folderInputRef.current.value = ''
      folderInputRef.current.click()
    }
  }

  /** 三种入口（选文件夹 / 多选 / 拖入）统一走这里：过滤排序 + 命中规格则自动定帧数 */
  const applyFiles = (raw: File[]) => {
    const parsed = parseImageFiles(raw)
    setError(null)
    setNotice(null)
    setResume(null)
    setProgress(null)
    setDraft((d) => {
      const base: UploadDraft = d ?? { frameCount: 144, files: null }
      const auto = (FRAME_COUNTS as readonly number[]).includes(parsed.length)
        ? (parsed.length as Frame360Count)
        : base.frameCount
      return { ...base, frameCount: auto, files: parsed }
    })
  }

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (draftRef.current === null) setDraft({ frameCount: 144, files: null })
    const files = await filesFromDataTransfer(e.dataTransfer)
    applyFiles(files)
  }

  /** 文件名自然序（数字感知）排序后统一重编号 1..N（§13） */
  const orderedFiles = (files: File[]) =>
    [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

  const validateDraft = (d: UploadDraft): string | null => {
    const files = d.files ?? []
    if (files.length === 0) return t('admin.s360.errNoFiles')
    if (files.length !== d.frameCount) return t('admin.s360.errCount', { need: d.frameCount, got: files.length })
    for (const f of files) {
      if (!FRAME_MIME.includes(f.type as (typeof FRAME_MIME)[number])) {
        return t('admin.s360.errFormat', { name: f.name })
      }
      if (f.size > FRAME_MAX_SIZE) return t('admin.s360.errSize', { name: f.name })
    }
    return null
  }

  const startUpload = () =>
    run(async () => {
      const d = draftRef.current
      if (!d) return
      const bad = validateDraft(d)
      if (bad) throw new Error(bad)
      const ordered = orderedFiles(d.files as File[])

      const { sequenceId } = await createSequence(assetId, d.frameCount)
      setResume({ sequenceId, indices: [] })
      setProgress({ done: 0, total: ordered.length })
      const parts = ordered.map((file, i) => ({ frame_index: i + 1, file }))
      const controller = new AbortController()
      abortRef.current = controller
      let r: Awaited<ReturnType<typeof uploadFrames>>
      try {
        r = await uploadFrames(sequenceId, parts, (done, total) => setProgress({ done, total }), controller.signal)
      } finally {
        abortRef.current = null
      }
      if (controller.signal.aborted) {
        // 主动中止：序列留在 uploading（已传帧已登记），行走「续传」入口；不报错
        setDraft(null)
        setResume(null)
        setProgress(null)
        setNotice(t('admin.s360.abortedNotice', { done: r.uploaded.length, total: ordered.length }))
        return
      }
      if (r.failed.length > 0) {
        // 保留草稿 + 序列：面板出现「重试缺失帧」，不新建序列
        setResume({ sequenceId, indices: r.failed.map((f) => f.frame_index) })
        throw new Error(t('admin.s360.errFrameFailed', { n: r.failed.length, msg: r.failed[0].error }))
      }
      await completeSequence(sequenceId)
      setResume(null)
      setDraft(null)
      setNotice(t('admin.s360.uploadedNotice'))
      // 上传完成即打开真实播放器预览（§16：确认无误再 Activate）
      const frames = await listSequenceFrameSources(sequenceId).catch(() => [])
      if (frames.length > 0) setPreview({ sequenceId, frames })
    })

  /** 只重传缺失帧到同一序列（frame_index 与原批次一致：同一份文件、同一确定性排序） */
  const retryMissing = () =>
    run(async () => {
      const rs = resume
      const d = draftRef.current
      if (!rs || !d?.files) return
      const ordered = orderedFiles(d.files)
      const parts = rs.indices.map((i) => ({ frame_index: i, file: ordered[i - 1] })).filter((p) => !!p.file)
      setProgress({ done: 0, total: parts.length })
      const controller = new AbortController()
      abortRef.current = controller
      let r: Awaited<ReturnType<typeof uploadFrames>>
      try {
        r = await uploadFrames(rs.sequenceId, parts, (done, total) => setProgress({ done, total }), controller.signal)
      } finally {
        abortRef.current = null
      }
      if (controller.signal.aborted) {
        // 中止续传：保留「重试缺失帧」入口（仅未成功登记的帧），不报错、不收尾
        const done = new Set(r.uploaded.map((u) => u.frame_index))
        const stillMissing = rs.indices.filter((i) => !done.has(i))
        setProgress(null)
        setDraft(null)
        setResume(stillMissing.length > 0 ? { sequenceId: rs.sequenceId, indices: stillMissing } : null)
        setNotice(t('admin.s360.abortedNotice', { done: r.uploaded.length, total: parts.length }))
        return
      }
      if (r.failed.length > 0) {
        setResume({ sequenceId: rs.sequenceId, indices: r.failed.map((f) => f.frame_index) })
        throw new Error(t('admin.s360.errFrameFailed', { n: r.failed.length, msg: r.failed[0].error }))
      }
      await completeSequence(rs.sequenceId)
      setResume(null)
      setDraft(null)
      setNotice(t('admin.s360.uploadedNotice'))
      const frames = await listSequenceFrameSources(rs.sequenceId).catch(() => [])
      if (frames.length > 0) setPreview({ sequenceId: rs.sequenceId, frames })
    })

  /** 行级补传：给「帧未齐」的序列再选一次文件，只重传缺失帧（草稿刷新后仍可用） */
  const pickForResume = (seqId: string) => {
    setResumeRow(seqId)
    setError(null)
    setNotice(null)
    if (resumeInputRef.current) {
      resumeInputRef.current.value = ''
      resumeInputRef.current.click()
    }
  }

  const handleResumeFiles = (files: FileList | null) =>
    run(async () => {
      const seqId = resumeRow
      if (!seqId || !files || files.length === 0) return
      const missing = await listMissingFrameIndices(seqId)
      if (missing.length === 0) throw new Error(t('admin.s360.errNoMissingFrames'))
      const ordered = orderedFiles(Array.from(files))
      const parts = missing
        .map((i) => ({ frame_index: i, file: ordered[i - 1] }))
        .filter((p): p is { frame_index: number; file: File } => !!p.file)
      if (parts.length !== missing.length) throw new Error(t('admin.s360.errResumeAlign'))
      setProgress({ done: 0, total: parts.length })
      const controller = new AbortController()
      abortRef.current = controller
      let r: Awaited<ReturnType<typeof uploadFrames>>
      try {
        r = await uploadFrames(seqId, parts, (done, total) => setProgress({ done, total }), controller.signal)
      } finally {
        abortRef.current = null
      }
      if (controller.signal.aborted) {
        // 中止行级补传：保留该行的「补传」入口，不报错、不收尾
        setProgress(null)
        setNotice(t('admin.s360.abortedNotice', { done: r.uploaded.length, total: parts.length }))
        return
      }
      if (r.failed.length > 0) {
        throw new Error(t('admin.s360.errFrameFailed', { n: r.failed.length, msg: r.failed[0].error }))
      }
      await completeSequence(seqId)
      setResumeRow(null)
      setNotice(t('admin.s360.uploadedNotice'))
      const frames = await listSequenceFrameSources(seqId).catch(() => [])
      if (frames.length > 0) setPreview({ sequenceId: seqId, frames })
    })

  // ---------- 序列动作 ----------
  const openPreview = (seq: Sequence360Summary) =>
    run(async () => {
      const frames = await listSequenceFrameSources(seq.id)
      if (frames.length === 0) throw new Error(t('admin.s360.errNoReadyFrames'))
      setPreview({ sequenceId: seq.id, frames })
    })

  const doActivate = (seq: Sequence360Summary) =>
    run(async () => {
      await activateSequence(seq.id)
      setPreview(null)
      setNotice(t('admin.s360.activatedNotice'))
      onAssetChanged()
    })

  /** Preview 内直接激活（§16 流程收口：拖一圈确认 → Activate） */
  const activateFromPreview = () => {
    const s = (sequences ?? []).find((x) => x.id === preview?.sequenceId)
    if (s) return doActivate(s)
    setPreview(null)
    return Promise.resolve()
  }

  const doRemove = (seq: Sequence360Summary) =>
    run(async () => {
      if (seq.is_active) await removeActive360(assetId)
      else await deleteSequence(seq.id)
      setNotice(t('admin.s360.removedNotice'))
      onAssetChanged()
    })

  if (loadError) {
    return (
      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="font-medium">{t('admin.s360.title')}</h2>
        <p className="text-sm text-destructive">{loadError}</p>
      </section>
    )
  }
  if (!sequences) {
    return (
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('admin.s360.title')}</h2>
        <div className="flex justify-center py-6">
          <Spinner className="h-5 w-5" />
        </div>
      </section>
    )
  }

  const active = sequences.find((s) => s.id === activeId) ?? null

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <input
        ref={resumeInputRef}
        type="file"
        accept={FRAME_MIME.join(',')}
        multiple
        className="hidden"
        onChange={(e) => void handleResumeFiles(e.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{t('admin.s360.title')}</h2>
        {active && <Badge variant="default">{t('admin.s360.live')}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{t('admin.s360.frontendNote')}</span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}

      {/* 无序列态（§45） */}
      {sequences.length === 0 && !draft && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('admin.s360.none')}</p>
          <Button size="sm" disabled={busy || disabled} onClick={() => openUpload()}>
            {t('admin.s360.upload')}
          </Button>
        </div>
      )}

      {/* 序列态 */}
      {sequences.length > 0 && (
        <ul className="space-y-2">
          {sequences.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <StatusDot status={s.status} />
              <span className="text-xs text-muted-foreground">
                {t('admin.s360.frames', { n: s.frame_count })}
                {s.status !== 'ready' && s.uploaded_frames < s.frame_count && (
                  <span> · {t('admin.s360.uploadedFrames', { n: s.uploaded_frames })}</span>
                )}
              </span>
              {s.is_active && <span className="text-xs font-medium text-success">{t('admin.s360.activeTag')}</span>}
              <div className="ml-auto flex gap-1">
                {s.status !== 'ready' && s.status !== 'deleting' && s.uploaded_frames < s.frame_count && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => pickForResume(s.id)}>
                    {t('admin.s360.resumeOnRow')}
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy || s.status !== 'ready'} onClick={() => void openPreview(s)}>
                  {t('admin.s360.preview')}
                </Button>
                <Button
                  size="sm"
                  variant={s.is_active ? 'ghost' : 'default'}
                  disabled={busy || s.status !== 'ready' || s.is_active}
                  onClick={() => void doActivate(s)}
                >
                  {t('admin.s360.activate')}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => openUpload()}>
                  {t('admin.s360.replace')}
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmRemove(s)}>
                  {t('admin.s360.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sequences.length > 0 && !draft && (
        <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => openUpload()}>
          {t('admin.s360.upload')}
        </Button>
      )}

      {/* 上传草稿面板 */}
      {draft && (
        <div className="space-y-3 rounded-md border border-dashed p-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t('admin.s360.frameCountLabel')}</span>
            <div className="flex flex-wrap gap-1.5">
              {FRAME_COUNTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft({ ...draft, frameCount: c })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent',
                    draft.frameCount === c && 'border-primary bg-primary/10 font-medium text-primary',
                  )}
                  title={FRAME_HINTS[c]}
                >
                  {c} · {FRAME_HINTS[c]}
                </button>
              ))}
            </div>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!busy) setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
            }}
            onDrop={(e) => void handleDropFiles(e)}
            className={cn(
              'rounded-md border border-dashed px-3 py-4 text-center transition-colors',
              dragOver ? 'border-primary bg-primary/5' : 'border-border',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={FRAME_MIME.join(',')}
              multiple
              className="hidden"
              onChange={(e) => applyFiles(e.target.files ? Array.from(e.target.files) : [])}
            />
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              {...({ webkitdirectory: '', directory: '' } as any)}
              onChange={(e) => applyFiles(e.target.files ? Array.from(e.target.files) : [])}
            />
            <FolderUp className={cn('mx-auto mb-1 h-5 w-5', dragOver ? 'text-primary' : 'text-muted-foreground')} />
            <p className="text-xs text-muted-foreground">{t('admin.s360.dropHint')}</p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={pickFolder}>
                {t('admin.s360.selectFolder')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={pickFiles}>
                {t('admin.s360.selectFiles')}
              </Button>
            </div>
            <span className="mt-1 block text-xs text-muted-foreground">
              {draft.files
                ? t('admin.s360.chosen', { n: draft.files.length, need: draft.frameCount })
                : t('admin.s360.selectHint')}
            </span>
          </div>

          {progress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {t('admin.s360.uploadingProgress', { done: progress.done, total: progress.total })}
              </span>
            </div>
          )}

          <div className="flex gap-2">
            {resume && resume.indices.length > 0 ? (
              <Button size="sm" disabled={busy} onClick={() => void retryMissing()}>
                {t('admin.s360.retryMissing', { n: resume.indices.length })}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !draft.files} onClick={() => void startUpload()}>
                {busy ? t('admin.s360.busy') : t('admin.s360.startUpload')}
              </Button>
            )}
            {progress && (
              <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
                {t('admin.s360.abort')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null)
                setResume(null)
                setProgress(null)
              }}
            >
              {t('admin.s360.cancel')}
            </Button>
          </div>
          {resume && resume.indices.length > 0 && (
            <p className="text-xs text-muted-foreground">{t('admin.s360.resumeHint')}</p>
          )}
        </div>
      )}

      {/* Preview：真实播放器（与前台同一组件），独立 overlay，不进图片 Lightbox（§28） */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          role="dialog"
          aria-modal="true"
          aria-label={t('admin.s360.previewAria')}
        >
          <div className="flex items-center justify-between p-4 text-white">
            <span className="text-sm">{t('admin.s360.previewTitle')}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void activateFromPreview()}>
                {t('admin.s360.activate')}
              </Button>
              <button type="button" aria-label={t('admin.s360.close')} className="rounded-full p-2 text-white hover:bg-white/10" onClick={() => setPreview(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="w-full max-w-4xl">
              <Spin360 frames={preview.frames} maxStage={1000} />
              <p className="mt-2 text-center text-xs text-white/70">{t('admin.s360.previewBodyHint')}</p>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title={t('admin.s360.removeConfirmTitle')}
        destructive
        confirmLabel={t('admin.s360.remove')}
        description={confirmRemove?.is_active ? t('admin.s360.removeConfirmActive') : t('admin.s360.removeConfirmIdle')}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          const s = confirmRemove
          setConfirmRemove(null)
          if (s) void doRemove(s)
        }}
      />
    </section>
  )
}

/** 序列状态点（后台管理信息） */
function StatusDot({ status }: { status: Sequence360Summary['status'] }) {
  const map: Record<Sequence360Summary['status'], { color: string; key: string }> = {
    ready: { color: 'bg-green-600', key: 'stReady' },
    uploading: { color: 'bg-blue-500', key: 'stUploading' },
    draft: { color: 'bg-muted-foreground/40', key: 'stDraft' },
    failed: { color: 'bg-destructive', key: 'stFailed' },
    deleting: { color: 'bg-amber-500', key: 'stDeleting' },
  }
  const s = map[status]
  const { t } = useLocale()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={cn('h-2 w-2 rounded-full', s.color)} />
      {t(`admin.s360.${s.key}`)}
    </span>
  )
}
