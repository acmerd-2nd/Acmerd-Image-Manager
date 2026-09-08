import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getAdminStats, getPlatformSettings, updatePlatformSettings, uploadBrandLogo, deleteBrandLogo, type AdminStats, type PlatformSettings } from '@/features/admin/api'
import { getSiteSettings } from '@/features/settings/api'
import { brandLogoUrl } from '@/lib/image-source'
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

/** V1.4 站点品牌：导航/标题文字 + GitHub 图仓库 Logo（无需新端点：文字走 /api/admin/settings，Logo 走新端点） */
function BrandingCard() {
  const { t } = useLocale()
  const [brandText, setBrandText] = useState('ACMERD · 探知')
  const [brandTitle, setBrandTitle] = useState('ACMERD · 探知')
  const [logoPath, setLogoPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    getSiteSettings()
      .then((s) => {
        setBrandText(s.brand_text || 'ACMERD · 探知')
        setBrandTitle(s.brand_title || 'ACMERD · 探知')
        setLogoPath(s.brand_logo_path || '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const saveText = async () => {
    if (!brandText.trim() || !brandTitle.trim()) {
      setError(t('admin.brand.brandTextRequired'))
      return
    }
    if (brandText.length > 60 || brandTitle.length > 60) {
      setError(t('admin.brand.tooLong'))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updatePlatformSettings({ brand_text: brandText, brand_title: brandTitle })
      setSaved(true)
    } catch (e) {
      setError(t('admin.brand.saveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
    setBusy(false)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) {
      setLogoFile(f)
      setPreview(URL.createObjectURL(f))
      setError(null)
    }
  }

  const uploadLogo = async () => {
    if (!logoFile) return
    setUploading(true)
    setError(null)
    try {
      const r = await uploadBrandLogo(logoFile)
      setLogoPath(r.path)
      setLogoFile(null)
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
    } catch (e) {
      setError(t('admin.brand.uploadFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
    setUploading(false)
  }

  const removeLogo = async () => {
    setUploading(true)
    setError(null)
    try {
      await deleteBrandLogo()
      setLogoPath('')
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
      setLogoFile(null)
    } catch (e) {
      setError(t('admin.brand.uploadFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
    setUploading(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.brand.title')}</CardTitle>
        <CardDescription>{t('admin.brand.brandTextHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('admin.brand.brandText')}</span>
          <Input
            value={brandText}
            maxLength={60}
            disabled={busy}
            onChange={(e) => {
              setBrandText(e.target.value)
              setError(null)
              setSaved(false)
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('admin.brand.brandTitle')}</span>
          <Input
            value={brandTitle}
            maxLength={60}
            disabled={busy}
            onChange={(e) => {
              setBrandTitle(e.target.value)
              setError(null)
              setSaved(false)
            }}
          />
        </label>

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={saveText}>
            {busy ? <Spinner className="mr-1 h-4 w-4" /> : null}
            {t('admin.brand.saveText')}
          </Button>
          {saved && <span className="text-xs text-muted-foreground">{t('admin.brand.saved')}</span>}
        </div>

        <div className="border-t pt-4">
          <div className="text-sm font-medium">{t('admin.brand.logoLabel')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.brand.logoHint')}</p>

          <div className="mt-3 flex items-center gap-4">
            {logoPath ? (
              <img src={brandLogoUrl(logoPath)} alt="logo" className="h-10 w-auto rounded border bg-muted p-1" />
            ) : preview ? (
              <img src={preview} alt="preview" className="h-10 w-auto rounded border bg-muted p-1" />
            ) : (
              <div className="flex h-10 w-20 items-center justify-center rounded border border-dashed text-xs text-muted-foreground">
                {t('admin.brand.noLogo')}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={onFile} />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={!logoFile || uploading} onClick={uploadLogo}>
                  {uploading ? <Spinner className="mr-1 h-4 w-4" /> : null}
                  {t('admin.brand.uploadLogo')}
                </Button>
                {logoPath && (
                  <Button size="sm" variant="ghost" disabled={uploading} onClick={removeLogo}>
                    {t('admin.brand.removeLogo')}
                  </Button>
                )}
              </div>
            </div>
          </div>
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

          <BrandingCard />

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
