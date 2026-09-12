import { useId } from 'react'
import { useLocale } from '@/i18n'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { Button } from '@/components/ui/button'

/**
 * 轻量确认对话框（V1 自维护，不引入 radix Dialog）。
 * 标题/描述/confirmLabel 由调用方传 i18n 文案；Cancel 用 common.cancel。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useLocale()
  const titleId = useId()
  const panelRef = useFocusTrap<HTMLDivElement>(open, onCancel)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={panelRef}
        className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        {description && (
          <div className="mt-2 text-sm text-muted-foreground whitespace-pre-line">{description}</div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
