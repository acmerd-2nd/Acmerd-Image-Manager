import { useEffect, useRef } from 'react'
import { Download, X } from 'lucide-react'
import { toPublicUrl } from '@/features/assets/api'
import type { ImageRow } from '@/types/database'

/**
 * 全屏图片预览（Phase 9 D7）：自建、零依赖。
 * 要求：Esc 关闭；关闭后焦点回到触发元素；移动端锁背景滚动避免双滚动冲突。
 * 预览加载原图（展示合规：进入此页的 asset 必为 published，其对象本就公开可读，
 * 与卡片/网格展示同一权限面，不越权；下载仍走 worker 鉴权链路）。
 */
export function Lightbox({
  image,
  onClose,
  onDownload,
}: {
  image: ImageRow
  onClose: () => void
  onDownload: (image: ImageRow) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(
    typeof document !== 'undefined' ? document.activeElement : null,
  )

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // 锁背景滚动，避免移动端 overlay 与页面双滚动冲突
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      // 关闭后焦点回到触发元素
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <div className="flex items-center justify-between p-4 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="truncate text-sm">{image.filename}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Download"
            className="rounded-full p-2 hover:bg-white/10"
            onClick={() => onDownload(image)}
          >
            <Download className="h-5 w-5" />
          </button>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            className="rounded-full p-2 hover:bg-white/10"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <img
          src={toPublicUrl(image)}
          alt={image.filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>
  )
}
