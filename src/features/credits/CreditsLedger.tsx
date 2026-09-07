import { useCallback, useEffect, useState } from 'react'
import type { CreditTransactionRow } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import { listOwnTransactions } from '@/features/credits/api'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'

/**
 * V1.3 C1–C5：用户积分流水（Profile 内嵌区块，纯读）。
 * C2: limit 50 + 加载更多；C3: 类型/时间/±金额/余额快照 + metadata 已知键；C5: DB 原值带符号显示。
 * 数据面 = 0010 RLS `select own`，天然只见本人流水。
 */

const TYPE_KEY: Record<string, string> = {
  image_download: 'credits.type.imageDownload',
  zip_download: 'credits.type.zipDownload',
  package_download: 'credits.type.packageDownload',
  admin_adjustment: 'credits.type.adminAdjustment',
  download_refund: 'credits.type.downloadRefund',
  seed_initial: 'credits.type.seedInitial',
}

/** metadata 已知键的展示（C3：不 join 资产名，已有明细直接展示） */
function metaDetail(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null
  const parts: string[] = []
  if (typeof meta.filename === 'string' && meta.filename) parts.push(meta.filename)
  if (typeof meta.image_count === 'number') parts.push(`${meta.image_count}`)
  if (typeof meta.reason === 'string' && meta.reason) parts.push(meta.reason)
  return parts.length ? parts.join(' · ') : null
}

export function CreditsLedger() {
  const { t } = useLocale()
  const { user } = useAuth()
  const [rows, setRows] = useState<CreditTransactionRow[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const uid = user?.id

  const load = useCallback(
    async (offset: number, append: boolean) => {
    if (!uid) return
    try {
      const { rows: next, hasMore: more } = await listOwnTransactions(uid, offset)
      setRows((prev) => (append ? [...(prev ?? []), ...next] : next))
      setHasMore(more)
    } catch (e) {
      if (!append) setRows([])
      setError(e instanceof Error ? e.message : String(e))
    }
    },
    [uid],
  )

  useEffect(() => {
    if (uid) load(0, false)
  }, [load, uid])

  const fmtAmount = (raw: string): string => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return raw
    return n < 0 ? `−${Math.abs(n).toLocaleString()}` : `+${n.toLocaleString()}`
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <h3 className="text-sm font-medium">{t('credits.ledgerTitle')}</h3>

      {rows === null ? (
        <div className="flex justify-center py-4">
          <Spinner className="h-5 w-5" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{t('common.error')}</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t('credits.ledgerEmpty')}</p>
      ) : (
        <>
          <div className="space-y-1">
            {rows.map((r) => {
              const n = Number(r.amount)
              const negative = Number.isFinite(n) && n < 0
              const detail = metaDetail(r.metadata)
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t(TYPE_KEY[r.type] ?? 'credits.type.unknown')}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                      {detail ? ` · ${detail}` : ''}
                    </div>
                  </div>
                  <span className={`shrink-0 tabular-nums ${negative ? 'text-foreground' : 'text-green-600'}`}>
                    {fmtAmount(r.amount)}
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {t('credits.balanceAfter', { n: Number(r.balance_after).toLocaleString() })}
                  </span>
                </div>
              )
            })}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true)
                  await load(rows.length, true)
                  setLoadingMore(false)
                }}
              >
                {loadingMore ? <Spinner className="h-4 w-4" /> : t('credits.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
