import { useEffect, useState } from 'react'
import { Download, HardDrive } from 'lucide-react'
import { fetchDownloadSources, type DownloadSourceRow } from '@/features/downloads/api'
import { isSafePackageUrl } from '@/lib/validators'
import { useLocale } from '@/i18n'
import { useAuth } from '@/features/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'

/**
 * Package Download（网盘）—— 与当前语言完全解耦：
 * 只订阅 assetId，不接收 language state。
 * 规则：0 源隐藏 / 1 源直接跳转 / 2 源弹选择器。
 * URL 仅来自 RLS 过滤后的 DB 记录，且 window.open 前再过 isSafePackageUrl（二次防御）。
 */
function openExternal(url: string) {
  if (!isSafePackageUrl(url)) {
    console.warn('Blocked unsafe package URL')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function PackageDownloadPanel({ assetId }: { assetId: string }) {
  const { session } = useAuth()
  const { t } = useLocale()
  const [sources, setSources] = useState<DownloadSourceRow[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // 仅在登录态拉取（guest 由 RLS 返回 0 行，这里也直接不请求，显示登录引导）
  useEffect(() => {
    if (!session) {
      setSources(null)
      return
    }
    let cancelled = false
    fetchDownloadSources(assetId).then((rows) => {
      if (!cancelled) setSources(rows.filter((r) => isSafePackageUrl(r.url)))
    })
    return () => {
      cancelled = true
    }
  }, [assetId, session])

  const providerLabel = (provider: string) =>
    provider === 'quark' ? t('download.packageQuark') : provider === 'baidu' ? t('download.packageBaidu') : provider

  // guest：不显示网盘链接，仅登录引导
  if (!session) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <HardDrive className="mb-1 h-4 w-4" />
        {t('download.packageNeedLogin')}
      </div>
    )
  }

  if (sources === null) {
    return (
      <div className="flex justify-center py-4">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  // n = 0 → 整块隐藏
  if (sources.length === 0) return null

  // n = 1 → 直接跳转
  if (sources.length === 1) {
    return (
      <Button className="w-full" onClick={() => openExternal(sources[0].url)}>
        <Download className="mr-2 h-4 w-4" />
        {t('download.packageTitle')}
      </Button>
    )
  }

  // n = 2 → 选择器
  return (
    <div className="relative">
      <Button className="w-full" onClick={() => setMenuOpen((v) => !v)}>
        <Download className="mr-2 h-4 w-4" />
        {t('download.packageTitle')}
      </Button>
      {menuOpen && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border bg-background p-1 shadow-lg">
          <div className="px-3 py-1.5 text-xs text-muted-foreground">{t('download.packageChooseSource')}</div>
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => {
                setMenuOpen(false)
                openExternal(s.url)
              }}
            >
              {providerLabel(s.provider)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
