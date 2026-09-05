import { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { fetchMyCredits } from '@/features/downloads/api'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'

/**
 * PC-4：登录用户右上角余额徽标（总纲 §57）。
 * 读 credit_accounts RLS select own（无新端点）；unlimited 显示 ∞；
 * 余额变化由父组件传入 balanceKey 触发重读（下载后刷新）。
 */
export function CreditsBadge({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useLocale()
  const [state, setState] = useState<{ balance: number; unlimited: boolean } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchMyCredits()
      .then((v) => {
        if (!cancelled) {
          setState(v)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (failed || state === null) {
    if (!failed) {
      return (
        <Badge variant="secondary" className="gap-1">
          <Coins className="h-3.5 w-3.5" />
          …
        </Badge>
      )
    }
    return null // 加载失败不占位（下载时服务端仍兜底）
  }

  return (
    <Badge variant="secondary" className="gap-1" title={t('credits.balance')}>
      <Coins className="h-3.5 w-3.5" />
      {state.unlimited ? t('credits.unlimitedShort') : state.balance}
    </Badge>
  )
}
