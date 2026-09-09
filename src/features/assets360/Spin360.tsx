import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minimize, Pause, RotateCw } from 'lucide-react'
import { make360FrameUrl, type Frame360Source } from '@/lib/image-source'
import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * V1.5 360° 序列播放器（后台 Preview 与前台 360° View 共用同一实现）。
 *
 * 产品硬规则（规格 §54 / Gate §G5）：
 * - 对外只有「360° View」一个能力；36/72/144/360 只是帧密度规格，
 *   组件内任何文案都不得出现帧数（加载提示 = Loading 360° View…）。
 * - 与普通图片 Lightbox 完全分离：帧不可点击进入单图查看（§28）。
 *
 * 性能硬规则（规格 §24–26、§42–43）：
 * - 首帧优先：frame[0] 解码完成即可交互，不等其余帧；
 * - 邻帧预载（当前帧 ±PRELOAD_RADIUS，按拖动方向加权）+ LRU 上限 CACHE_MAX；
 * - 绝不一次性实例化 N 个 DOM <img>：缓存是脱离文档的 Image 对象，画面只有 1 个 <img>；
 * - 高速拖动时显示「最近的已就绪帧」，不严格排队 → 不卡顿、不空白。
 *
 * 交互（§19–23、§29）：指针拖拽（右拖正方向）/ 触摸横滑（touch-action:pan-y 保留纵向滚动）/
 * ←→ 逐帧 / Auto Rotate 单速默认关 / Fullscreen + Esc。
 */

const CACHE_MAX = 24
const PRELOAD_RADIUS = 8
/** 灵敏度：水平每 PX_PER_FRAME 像素推进一帧（360 帧一周约 2160px 拖动） */
const PX_PER_FRAME = 6
const AUTO_ROTATE_FPS = 12

export interface Spin360Props {
  frames: Frame360Source[]
  className?: string
  /** 容器最大高度（前台默认 60vh，后台 Preview 用更大值） */
  maxHeightClass?: string
}

export function Spin360({ frames, className, maxHeightClass = 'max-h-[60vh]' }: Spin360Props) {
  const { t } = useLocale()
  const n = frames.length
  const urls = useMemo(() => frames.map((f) => make360FrameUrl(f) ?? ''), [frames])

  const [target, setTarget] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadedCount, setLoadedCount] = useState(0)
  const [autoplay, setAutoplay] = useState(false)
  const [isFs, setIsFs] = useState(false)
  const [aspect, setAspect] = useState<number | null>(null)
  const [touched, setTouched] = useState(false)

  const cache = useRef(new Map<number, HTMLImageElement>())
  const pending = useRef(new Map<number, Promise<HTMLImageElement>>())
  const readySet = useRef(new Set<number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x0: number; idx0: number } | null>(null)
  const dirRef = useRef(1)
  const displayRef = useRef(0)

  const wrap = useCallback((i: number) => ((i % n) + n) % n, [n])

  const evict = useCallback(() => {
    const c = cache.current
    if (c.size <= CACHE_MAX) return
    for (const key of Array.from(c.keys())) {
      if (c.size <= CACHE_MAX) break
      if (key === displayRef.current) continue // 展示帧不驱逐（避免可见画面闪回）
      c.delete(key)
      readySet.current.delete(key)
    }
    setLoadedCount(readySet.current.size)
  }, [])

  /** 确保某帧已解码入缓存（同 URL 命中浏览器缓存，重复调用零成本） */
  const ensure = useCallback(
    (i: number) => {
      const idx = wrap(i)
      const hit = cache.current.get(idx)
      if (hit && readySet.current.has(idx)) {
        cache.current.delete(idx)
        cache.current.set(idx, hit) // LRU touch
        return Promise.resolve(hit)
      }
      const inflight = pending.current.get(idx)
      if (inflight) return inflight
      const url = urls[idx]
      if (!url) return Promise.reject(new Error('no url'))
      const img = new Image()
      const p = new Promise<HTMLImageElement>((resolve, reject) => {
        img.onload = () => {
          readySet.current.add(idx)
          cache.current.set(idx, img)
          pending.current.delete(idx)
          evict()
          setLoadedCount(readySet.current.size)
          resolve(img)
        }
        img.onerror = () => {
          pending.current.delete(idx)
          reject(new Error(`frame ${idx} load failed`))
        }
      })
      pending.current.set(idx, p)
      img.src = url
      return p
    },
    [evict, urls, wrap],
  )

  // 首帧优先：frame[0] 就绪即进入可交互态（其余帧后台继续）
  useEffect(() => {
    if (n === 0) return
    let cancelled = false
    setPhase('loading')
    ensure(0)
      .then((img) => {
        if (cancelled) return
        if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight)
        setPhase('ready')
      })
      .catch(() => {
        if (!cancelled) setPhase('error')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, urls])

  /** 最近的已就绪帧（不严格排队 → 高速拖动不空白） */
  const display = useMemo(() => {
    if (n === 0) return 0
    const span = Math.max(4, Math.ceil(n / 2))
    for (let d = 0; d <= span; d++) {
      const a = wrap(target - d)
      const b = wrap(target + d)
      if (readySet.current.has(a)) return a
      if (readySet.current.has(b)) return b
    }
    return target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, loadedCount, n, wrap])
  displayRef.current = display

  // 邻帧预载：方向感知（正向拖动先 +，反向先 -）
  useEffect(() => {
    if (phase !== 'ready') return
    const dir = dirRef.current
    const offsets: number[] = []
    for (let k = 1; k <= PRELOAD_RADIUS; k++) offsets.push(dir * k, -dir * k)
    for (const o of offsets) {
      const idx = wrap(target + o)
      if (!readySet.current.has(idx)) ensure(idx).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, phase])

  // Auto Rotate：单速（规格 §23：第一版不做多档速度）
  useEffect(() => {
    if (!autoplay || phase !== 'ready') return
    const id = window.setInterval(() => setTarget((v) => wrap(v + 1)), 1000 / AUTO_ROTATE_FPS)
    return () => window.clearInterval(id)
  }, [autoplay, phase, wrap])

  // Fullscreen（独立 overlay，复用滚动锁定思路但不进 Lightbox）
  useEffect(() => {
    const onFsChange = () => setIsFs(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void containerRef.current?.requestFullscreen?.().catch(() => {})
  }

  // ---------- 指针拖拽（桌面 + 触摸统一） ----------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== 'ready') return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { x0: e.clientX, idx0: target }
    setAutoplay(false)
    setTouched(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    // 右拖 = 正方向（规格 §19）；纵向位移交给页面滚动（touch-action: pan-y）
    const dx = e.clientX - d.x0
    const idx = wrap(Math.round(d.idx0 + dx / PX_PER_FRAME))
    dirRef.current = dx >= 0 ? 1 : -1
    if (idx !== target) setTarget(idx)
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (dragRef.current) dragRef.current = null
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (phase !== 'ready') return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setAutoplay(false)
      setTarget((v) => wrap(v + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setAutoplay(false)
      setTarget((v) => wrap(v - 1))
    }
  }

  if (n === 0) return null

  const src = urls[display] ?? ''

  return (
    <div
      ref={containerRef}
      className={cn(
        'group relative select-none overflow-hidden rounded-lg border bg-muted/30',
        isFs && 'flex h-screen w-screen items-center justify-center rounded-none bg-black',
        className,
      )}
    >
      {/* 画面层：单一 <img>，帧切换只改 src（缓存命中即时） */}
      <div
        role="img"
        aria-label={t('asset.s360.viewLabel')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          'relative w-full touch-pan-y outline-none',
          phase === 'ready' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
        style={aspect ? { aspectRatio: String(aspect), maxHeight: isFs ? '100vh' : undefined } : undefined}
      >
        {phase !== 'error' && (
          <img
            src={src}
            alt=""
            draggable={false}
            className={cn(
              'mx-auto block w-full object-contain transition-opacity',
              phase === 'ready' ? 'opacity-100' : 'opacity-0',
              !isFs && maxHeightClass,
            )}
          />
        )}

        {phase === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <RotateCw className="h-4 w-4 animate-spin" />
            {t('asset.s360.loading')}
          </div>
        )}

        {phase === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('asset.s360.loadFailed')}</p>
            <button
              type="button"
              className="rounded-md border px-3 py-1 text-sm hover:bg-accent"
              onClick={() => {
                readySet.current.clear()
                cache.current.clear()
                setPhase('loading')
                ensure(0)
                  .then(() => setPhase('ready'))
                  .catch(() => setPhase('error'))
              }}
            >
              {t('asset.s360.retry')}
            </button>
          </div>
        )}

        {phase === 'ready' && !touched && !autoplay && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="rounded-full bg-black/55 px-3 py-1 text-xs text-white">{t('asset.s360.dragHint')}</span>
          </div>
        )}
      </div>

      {/* 控制层：仅两个轻量按钮（规格 §21：不堆控件） */}
      {phase === 'ready' && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            aria-label={autoplay ? t('asset.s360.stopRotate') : t('asset.s360.autoRotate')}
            aria-pressed={autoplay}
            onClick={() => setAutoplay((v) => !v)}
            className="rounded-full bg-black/55 p-1.5 text-white hover:bg-black/70"
          >
            {autoplay ? <Pause className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
          </button>
          <button
            type="button"
            aria-label={isFs ? t('asset.s360.exitFullscreen') : t('asset.s360.fullscreen')}
            onClick={toggleFs}
            className="rounded-full bg-black/55 p-1.5 text-white hover:bg-black/70"
          >
            {isFs ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      )}
    </div>
  )
}
