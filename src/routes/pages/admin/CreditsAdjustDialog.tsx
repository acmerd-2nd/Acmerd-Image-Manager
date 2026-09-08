import { useState } from 'react'
import { useLocale } from '@/i18n'
import { updateUserCredits } from '@/features/admin/api'
import { useToast } from '@/components/ToastProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/**
 * V1.3.1 G3：积分调整 Dialog（AdminUsersPage 内嵌）。
 * - 快捷 +10/+50/+100：点击即生效（CR §10：小额免确认）+ Toast
 * - Set Balance：Reason 必填 + 确认对话「从 X 改为 Y?」
 * - 负调 −10/−50：默认折叠在「更多」内（CR §14：不摆显眼位置）
 * - Unlimited switch：免确认，Toast 反馈；不改 balance（既有 RPC 语义）
 * 语义：快捷加/减=客户端以「当前余额+delta」调 Set Balance 通道，
 * ledger 落 admin_adjustment(amount=±delta, from/to) + metadata.operation，与 CR §5.1/§7.2 一致。
 */
export function CreditsAdjustDialog({
  userId,
  displayName,
  balance,
  unlimited,
  onClose,
  onChanged,
}: {
  userId: string
  displayName: string
  balance: number
  unlimited: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const { t } = useLocale()
  const toast = useToast()

  const [busy, setBusy] = useState(false)
  const [newValue, setNewValue] = useState('')
  const [reason, setReason] = useState('')
  const [showNegative, setShowNegative] = useState(false)
  const [confirmSet, setConfirmSet] = useState<{ value: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const applyDelta = async (delta: number) => {
    setBusy(true)
    setErr(null)
    try {
      await updateUserCredits(userId, {
        balance: balance + delta,
        reason: `${delta > 0 ? 'quick_add' : 'quick_deduct'}: ${delta > 0 ? '+' : ''}${delta}`,
        operation: delta > 0 ? 'quick_add' : 'quick_deduct',
      })
      await onChanged()
      toast.success(t('admin.credits.toastAdjusted', { delta: (delta > 0 ? '+' : '') + delta, name: displayName }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast.error(t('admin.credits.toastFailed'))
    }
    setBusy(false)
  }

  const submitSetBalance = async (value: number) => {
    setBusy(true)
    setErr(null)
    try {
      await updateUserCredits(userId, { balance: value, reason: reason.trim(), operation: 'set_balance' })
      await onChanged()
      setConfirmSet(null)
      setNewValue('')
      setReason('')
      onClose()
      toast.success(t('admin.credits.toastSet', { from: balance, to: value, name: displayName }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast.error(t('admin.credits.toastFailed'))
    }
    setBusy(false)
  }

  const toggleUnlimited = async (next: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await updateUserCredits(userId, { unlimited: next, reason: 'admin_toggle_unlimited', operation: 'toggle_unlimited' })
      await onChanged()
      toast.success(next ? t('admin.credits.toastUnlimitedOn') : t('admin.credits.toastUnlimitedOff'))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast.error(t('admin.credits.toastFailed'))
    }
    setBusy(false)
  }

  const parsed = Number(newValue)
  const setOk = Number.isFinite(parsed) && parsed >= 0 && reason.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div
        className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="text-lg font-semibold">{t('admin.credits.dialogTitle', { name: displayName })}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('admin.credits.currentBalance', { n: balance })}
          {unlimited ? ` · ${t('credits.unlimited')} ♾` : ''}
        </p>

        {/* 快捷 ±（CR §7/§14） */}
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            {[10, 50, 100].map((d) => (
              <Button key={d} size="sm" disabled={busy} onClick={() => applyDelta(d)}>
                +{d}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setShowNegative((v) => !v)}>
              {showNegative ? t('admin.credits.hideNegative') : t('admin.credits.showNegative')}
            </Button>
          </div>
          {showNegative && (
            <div className="flex flex-wrap gap-2">
              {[-10, -50].map((d) => (
                <Button key={d} size="sm" variant="outline" disabled={busy || balance + d < 0} onClick={() => applyDelta(d)}>
                  {d}
                </Button>
              ))}
              {balance < 10 && (
                <span className="self-center text-xs text-muted-foreground">{t('admin.credits.negativeBlocked')}</span>
              )}
            </div>
          )}
        </div>

        {/* Set Balance + Reason（CR §13） */}
        <div className="mt-4 space-y-2 border-t pt-4">
          <label htmlFor="credit-new-balance" className="text-sm font-medium">
            {t('admin.credits.setBalanceLabel')}
          </label>
          <Input
            id="credit-new-balance"
            inputMode="decimal"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder={String(balance)}
          />
          <label htmlFor="credit-reason" className="text-sm font-medium">
            {t('admin.credits.reasonLabel')}
          </label>
          <Input
            id="credit-reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.credits.reasonPlaceholder')}
          />
          <Button
            size="sm"
            className="w-full"
            disabled={busy || !setOk || parsed === balance}
            onClick={() => setConfirmSet({ value: parsed })}
          >
            {busy ? <Spinner className="h-4 w-4" /> : t('admin.credits.setBalanceBtn')}
          </Button>
          {newValue !== '' && Number.isFinite(parsed) && parsed !== balance && (
            <p className="text-xs text-muted-foreground">
              {t('admin.credits.deltaPreview', { delta: (parsed > balance ? '+' : '') + (parsed - balance) })}
            </p>
          )}
        </div>

        {/* Unlimited switch（免确认 + Toast） */}
        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <span className="text-sm font-medium">{t('admin.users.toggleUnlimited')}</span>
          <Button size="sm" variant={unlimited ? 'default' : 'outline'} disabled={busy} onClick={() => toggleUnlimited(!unlimited)}>
            {busy ? <Spinner className="h-4 w-4" /> : unlimited ? t('admin.platform.on') : t('admin.platform.off')}
          </Button>
        </div>

        {err && <p className="mt-3 text-sm text-destructive">{err}</p>}

        <div className="mt-4 flex justify-end border-t pt-4">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>

      {/* Set Balance 确认（CR §10）；stopPropagation：点确认框遮罩只关确认，不连带关闭本 Dialog */}
      {confirmSet && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            open
            title={t('admin.credits.confirmSetTitle', { name: displayName })}
            description={t('admin.credits.confirmSetBody', { from: balance, to: confirmSet.value })}
            confirmLabel={t('common.confirm')}
            onConfirm={() => submitSetBalance(confirmSet.value)}
            onCancel={() => setConfirmSet(null)}
          />
        </div>
      )}

    </div>
  )
}
