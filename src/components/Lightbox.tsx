import { useCallback, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { toPublicUrl } from '@/features/assets/api'
import type { ImageRow } from '@/types/database'
import { useLocale } from '@/i18n'

/**
 * 全屏图片预览（Phase 9 D7；V1.6.0-B 支持整组翻页）：自建、零依赖。
 * 交互：
 *  - Esc 关闭；关闭后焦点回到触发元素；背景锁滚动避免移动端双滚动冲突。
 *  - ←/→ 或左右翻页按钮切换，末张环形回到首张（images.length<=1 时自动隐藏导航）。
 *  - 移动端横向滑动翻页，纵向仍可滚动（touch-action: pan-y，与 Spin360 轴分离一致）。
 *  - 受控索引：翻页经 onIndexChange 回传父级，父级只存「当前语言列表 + 索引」，
 *    避免把图片对象透传进来导致跨语言切换时串图。
 * 预览加载原图（进入此页的 asset 必为 published，对象本就公开可读，与网格同权限面；下载仍走 worker 鉴权链路）。
 */
export function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
  onDownload,
}: {
  images: ImageRow[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  onDownload: (image: ImageRow) => void
}) {
  const { t } = useLocale()
  const closeRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(
    typeof document !== 'undefined' ? document.activeElement : null,
  )

  const n = images.length
  const safeIndex = index >= 0 && index < n ? index : 0
  const image = images[safeIndex]
  const navigable = n > 1

  // 内部镜像索引：让同一渲染帧内的连续翻页（快速连按 / 键重复）各自前进一步，
  // 而非都基于旧 safeIndex 计算；父级回传后由 effect 重新对齐权威索引。
  const idxRef = useRef(safeIndex)
  useEffect(() => {
    idxRef.current = safeIndex
  }, [safeIndex])

  const go = useCallback(
    (delta: number) => {
      if (n <= 1) return
      const target = (idxRef.current + delta + n) % n
      idxRef.current = target
      onIndexChange(target)
    },
    [n, onIndexChange],
  )

  // 键盘：Esc 关闭，←/→ 翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (navigable && e.key === 'ArrowRight') {
        e.preventDefault()
        go(1)
      } else if (navigable && e.key === 'ArrowLeft') {
        e.preventDefault()
        go(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, go, navigable])

  // 挂载一次：聚焦关闭键 + 锁背景滚动；卸载复位焦点与滚动
  useEffect(() => {
    closeRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [])

  // 触摸/指针横向滑动翻页（阈值 40px；纯点击位移≈0 不触发）
  const dragX = useRef<number | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    dragX.current = e.clientX
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragX.current === null) return
    const dx = e.clientX - dragX.current
    dragX.current = null
    if (navigable && Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
  }
  const onPointerCancel = () => {
    dragX.current = null
  }

  // V1.9.0：预取相邻原图（进入 Lightbox = 用户明确在浏览，预热 next/prev 让翻页瞬时）
  const preloadRefs = useRef<HTMLImageElement[]>([])
  useEffect(() => {
    if (!navigable) return
    const neighbors = [(safeIndex + 1) % n, (safeIndex - 1 + n) % n]
    const imgs = neighbors.map((i) => {
      const im = new Image()
      const url = toPublicUrl(images[i])
      if (url) im.src = url
      return im
    })
    preloadRefs.current = imgs
    return () => {
      preloadRefs.current = []
    }
  }, [navigable, safeIndex, n, images])

  if (!image) return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('asset.preview', { name: image.filename })}
    >
      {/* 顶栏：文件名 + 计数器 + 下载 / 关闭 */}
      <div
        className="flex items-center justify-between gap-3 p-4 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate text-sm">{image.filename}</span>
        <div className="flex shrink-0 items-center gap-3">
          {navigable && (
            <span className="text-sm tabular-nums text-white/80">
              {t('asset.previewCount', { current: safeIndex + 1, total: n })}
            </span>
          )}
          <button
            type="button"
            aria-label={t('asset.previewDownload')}
            className="rounded-full p-2 hover:bg-white/10"
            onClick={() => onDownload(image)}
          >
            <Download className="h-5 w-5" />
          </button>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close')}
            className="rounded-full p-2 hover:bg-white/10"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* 图像区：左右翻页按钮 + 滑动/滚动 */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-auto p-4"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ touchAction: 'pan-y' }}
      >
        <img
          key={image.id}
          src={toPublicUrl(image)}
          alt={image.filename}
          className="max-h-full max-w-full object-contain select-none"
          draggable={false}
        />
        {navigable && (
          <>
            <button
              type="button"
              aria-label={t('asset.previewPrev')}
              onClick={() => go(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:left-4"
            >
              <ChevronLeft className="h-7 w-7" />
            </button>
            <button
              type="button"
              aria-label={t('asset.previewNext')}
              onClick={() => go(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:right-4"
            >
              <ChevronRight className="h-7 w-7" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
