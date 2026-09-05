import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getAdminStats, getPlatformSettings, updatePlatformSettings, type AdminStats, type PlatformSettings } from '@/features/admin/api'
import { LANGUAGE_CODES, LANGUAGE_LABELS, type AssetStatus } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u += 1
  } while (v >= 1024 && u < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`
}

const ASSET_STATUS_ORDER: AssetStatus[] = ['draft', 'published', 'archived']

function StatCard({
  label,
  value,
  note,
  children,
}: {
  label: string
  value: string
  note?: string
  children?: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
        {children}
      </CardContent>
    </Card>
  )
}

/** Apple 风格开关（复用既有视觉；PC-6 Part A 抽为局部组件供 Schedule/Registration 两处用） */
function AppleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all',
          checked ? 'left-[1.375rem]' : 'left-0.5',
        )}
      />
    </button>
  )
}

/** PC-6 Part A：Platform Controls —— Schedule + Registration 开关 + 3 个下载价格（复用 /api/admin/settings，零新端点/零 schema） */
function PlatformControlsCard() {
  const { t } = useLocale()
  const [settings, setSettings] = useState<PlatformSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [prices, setPrices] = useState<{ single: string; zip: string; package: string }>({
    single: '',
    zip: '',
    package: '',
  })

  useEffect(() => {
    getPlatformSettings()
      .then((s) => {
        setSettings(s)
        setPrices({
          single: String(s.single_image_download_cost),
          zip: String(s.zip_download_cost_per_image),
          package: String(s.package_download_cost),
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const apply = async (patch: Partial<PlatformSettings>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updatePlatformSettings(patch)
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
      setSaved(true)
    } catch (e) {
      setError(t('admin.platform.saveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
    setBusy(false)
  }

  const PRICE_FIELDS = [
    { key: 'single', label: 'admin.platform.singleCost' },
    { key: 'zip', label: 'admin.platform.zipCostPerImage' },
    { key: 'package', label: 'admin.platform.packageCost' },
  ] as const

  const intOk = (s: string) => /^\d+$/.test(s) && Number(s) >= 0 && Number(s) <= 1000000

  const savePrices = async () => {
    if (!PRICE_FIELDS.every((f) => intOk(prices[f.key]))) {
      setError(t('admin.platform.invalidPrice'))
      return
    }
    await apply({
      single_image_download_cost: Number(prices.single),
      zip_download_cost_per_image: Number(prices.zip),
      package_download_cost: Number(prices.package),
    })
  }

  if (settings === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.platform.title')}</CardTitle>
        </CardHeader>
        <CardContent className="py-12">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <div className="flex justify-center">
              <Spinner className="h-5 w-5" />
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.platform.title')}</CardTitle>
        <CardDescription>{t('admin.platform.priceHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t('admin.platform.scheduleNav')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.platform.scheduleNavHint')}</p>
          </div>
          <AppleSwitch
            ariaLabel={t('admin.platform.scheduleNav')}
            checked={settings.schedule_navigation_enabled}
            disabled={busy}
            onChange={() => apply({ schedule_navigation_enabled: !settings.schedule_navigation_enabled })}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t('admin.platform.registration')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.platform.registrationHint')}</p>
          </div>
          <AppleSwitch
            ariaLabel={t('admin.platform.registration')}
            checked={settings.registration_enabled}
            disabled={busy}
            onChange={() => apply({ registration_enabled: !settings.registration_enabled })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {PRICE_FIELDS.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="text-sm font-medium">{t(f.label)}</span>
              <Input
                type="number"
                min={0}
                max={1000000}
                step={1}
                inputMode="numeric"
                value={prices[f.key]}
                disabled={busy}
                onChange={(e) => {
                  setPrices((p) => ({ ...p, [f.key]: e.target.value }))
                  setError(null)
                  setSaved(false)
                }}
              />
            </label>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={savePrices}>
            {busy ? <Spinner className="mr-1 h-4 w-4" /> : null}
            {t('admin.platform.savePrices')}
          </Button>
          {saved && <span className="text-xs text-muted-foreground">{t('admin.platform.saved')}</span>}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

/** Dashboard：统计卡 + 语言分布；全部来自一次 getAdminStats()（D5 + 约束 4 单一端点） */
export function AdminDashboardPage() {
  const { isAdmin } = useAuth()
  const { t } = useLocale()
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStats(await getAdminStats())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

  const langRows = LANGUAGE_CODES.map((code) => ({
    code,
    label: LANGUAGE_LABELS[code],
    count: stats?.imagesByLanguage?.[code] ?? 0,
  }))
  const maxLang = Math.max(1, ...langRows.map((r) => r.count))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('admin.page.dashboard')}</h1>
        <Button size="sm" variant="outline" disabled={loading} onClick={reload}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {t('admin.refresh')}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {stats === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t('admin.stat.assets')} value={String(stats.totalAssets)}>
              <div className="mt-2 flex flex-wrap gap-1">
                {ASSET_STATUS_ORDER.map((s) => (
                  <Badge key={s} variant={s === 'published' ? 'default' : 'secondary'}>
                    {s}: {stats.assetsByStatus?.[s] ?? 0}
                  </Badge>
                ))}
              </div>
            </StatCard>
            <StatCard label={t('admin.stat.images')} value={String(stats.totalImages)} />
            <StatCard
              label={t('admin.stat.users')}
              value={String(stats.totalUsers)}
              note={t('admin.stat.disabledNote', { n: stats.disabledUsers })}
            />
            <StatCard
              label={t('admin.stat.storageUsed')}
              value={formatBytes(stats.storageUsedBytes)}
              note={t('admin.stat.storageNote')}
            />
          </div>

          <PlatformControlsCard />

          <Card>
            <CardHeader>
              <CardTitle>{t('admin.stat.byLanguage')}</CardTitle>
              <CardDescription>{t('admin.stat.byLanguageDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {langRows.map((r) => (
                <div key={r.code} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm text-muted-foreground">
                    {r.label} ({r.code})
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary"
                      style={{ width: `${(r.count / maxLang) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-sm tabular-nums">{r.count}</span>
                </div>
              ))}
              {stats.totalImages === 0 && (
                <p className="text-sm text-muted-foreground">{t('admin.stat.noImages')}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
