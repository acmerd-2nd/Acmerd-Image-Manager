import { useEffect, useRef, useState } from 'react'
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import { Maximize2, RotateCcw, RotateCw, X, ZoomIn, ZoomOut, Check } from 'lucide-react'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'

/** 裁剪输出方形边长（px）：头像展示位小，512 兼顾高清且远小于 Worker 2MB 上限。 */
const OUTPUT_SIZE = 512

interface AvatarCropperDialogProps {
  /** 用户选中的原始图片文件 */
  file: File
  /** 取消（关闭弹窗） */
  onCancel: () => void
  /** 确认裁剪：把裁剪后的方形 JPEG 交回上层去上传 */
  onConfirm: (cropped: File) => void | Promise<void>
}

/**
 * V1.8.0 头像裁剪弹窗（Cropper.js，1:1）。
 * 无 shadcn Dialog 原语，自建定宽遮罩 + 面板；ESC 关闭、点遮罩不关（避免误丢裁剪状态）。
 * 严格模式下 effect 双调用：以 ref 持有实例并在 cleanup destroy，幂等安全。
 */
export function AvatarCropperDialog({ file, onCancel, onConfirm }: AvatarCropperDialogProps) {
  const { t } = useLocale()
  const imgRef = useRef<HTMLImageElement | null>(null)
  const cropperRef = useRef<Cropper | null>(null)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')

  // 用 objectURL 喂给 <img>，卸载时释放
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  // 图片就绪后初始化 Cropper
  useEffect(() => {
    if (!url || !imgRef.current) return
    const cropper = new Cropper(imgRef.current, {
      aspectRatio: 1,
      viewMode: 1,
      dragMode: 'move',
      autoCropArea: 0.9,
      background: true,
      movable: true,
      zoomable: true,
      rotatable: true,
      scalable: false,
      cropBoxMovable: true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false,
    })
    cropperRef.current = cropper
    return () => {
      cropper.destroy()
      cropperRef.current = null
    }
  }, [url])

  // ESC 关闭（裁剪中不拦 busy）
  useEffect(() => {
    if (busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const zoom = (factor: number) => cropperRef.current?.zoom(factor)
  const rotate = (deg: number) => cropperRef.current?.rotate(deg)
  const reset = () => cropperRef.current?.reset()

  const handleConfirm = async () => {
    const cropper = cropperRef.current
    if (!cropper) return
    const canvas = cropper.getCroppedCanvas({
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      // JPEG 无透明通道，白底铺满，避免源图透明区变黑
      fillColor: '#ffffff',
    })
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    )
    if (!blob) return
    setBusy(true)
    try {
      await onConfirm(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl bg-card text-card-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{t('auth.avatar.cropTitle')}</h2>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} aria-label={t('common.cancel')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 裁剪区：Cropper 需要图片以常规布局渲染，容器定高 */}
        <div className="h-[320px] w-full bg-muted">
          {url ? <img ref={imgRef} src={url} alt={t('auth.avatar.cropTitle')} /> : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => zoom(0.1)} disabled={busy} aria-label={t('auth.avatar.zoomIn')}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => zoom(-0.1)} disabled={busy} aria-label={t('auth.avatar.zoomOut')}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => rotate(-90)} disabled={busy} aria-label={t('auth.avatar.rotateLeft')}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => rotate(90)} disabled={busy} aria-label={t('auth.avatar.rotateRight')}>
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={reset} disabled={busy} aria-label={t('auth.avatar.reset')}>
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleConfirm} disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              <span>{t('auth.avatar.cropConfirm')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
