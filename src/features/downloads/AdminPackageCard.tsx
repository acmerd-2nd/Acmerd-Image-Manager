import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useLocale } from '@/i18n'
import { isSafePackageUrl } from '@/lib/validators'
import {
  DownloadSourceError,
  deleteDownloadSource,
  listDownloadSourcesAdmin,
  saveDownloadSource,
  type DownloadProvider,
} from '@/features/downloads/api'

/**
 * V1.6.0-A：Admin Asset Editor 的「资源包下载（网盘）」卡片。
 *
 * 只做一件事：往 public.download_sources 里按 (asset_id, provider) 写 / 改 / 删一行。
 * 读链路（前台 PackageDownloadPanel + Worker /api/downloads/package 原子扣分跳转）在
 * Phase 5 就已就绪；后台此前没有任何写入入口，本卡补齐。
 *
 * 约束（与既有防御同规则，零迁移零 Worker 改动）：
 * - provider 固定 quark / baidu（枚举 + DB 唯一键 (asset_id, provider)，各一行）；
 * - URL 前端先用 isSafePackageUrl 预校验（https + host 精确白名单），DB 0004 触发器终审；
 *   命中 DOWNLOAD_URL_INVALID → 本地化「链接不合规」提示，不落脏数据；
 * - enabled=false 的行前台不可见（RLS select 过滤 enabled）；删除 = 物理移除此网盘源；
 * - 全程 RLS admin 直连写，触发 download_source.updated 审计。
 */

const PROVIDERS: DownloadProvider[] = ['quark', 'baidu']

interface Draft {
  url: string
  enabled: boolean
  existingId: string | null
}

const emptyDraft = (): Draft => ({ url: '', enabled: true, existingId: null })

export function AdminPackageCard({ assetId }: { assetId: string }) {
  const { t } = useLocale()
  const [rows, setRows] = useState<Record<DownloadProvider, Draft>>({ quark: emptyDraft(), baidu: emptyDraft() })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<DownloadProvider | null>(null)

  const providerLabel = (p: DownloadProvider) =>
    p === 'quark' ? t('admin.packageCard.providerQuark') : t('admin.packageCard.providerBaidu')
  const urlPlaceholder = (p: DownloadProvider) =>
    p === 'quark' ? t('admin.packageCard.urlPlaceholderQuark') : t('admin.packageCard.urlPlaceholderBaidu')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const sources = await listDownloadSourcesAdmin(assetId)
      const next: Record<DownloadProvider, Draft> = { quark: emptyDraft(), baidu: emptyDraft() }
      for (const s of sources) {
        if (s.provider in next) next[s.provider] = { url: s.url, enabled: s.enabled, existingId: s.id }
      }
      setRows(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [assetId])

  useEffect(() => {
    reload()
  }, [reload])

  const setDraft = (p: DownloadProvider, patch: Partial<Draft>) =>
    setRows((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }))

  const save = async (p: DownloadProvider) => {
    setError(null)
    setNotice(null)
    const draft = rows[p]
    const url = draft.url.trim()
    if (!url) {
      setError(t('admin.packageCard.errEmpty'))
      return
    }
    if (!isSafePackageUrl(url)) {
      setError(t('admin.packageCard.errInvalidUrl'))
      return
    }
    setBusy(true)
    try {
      await saveDownloadSource({ assetId, provider: p, url, enabled: draft.enabled })
      await reload()
      setNotice(t('admin.packageCard.saved', { name: providerLabel(p) }))
    } catch (e) {
      if (e instanceof DownloadSourceError && e.code === 'invalid_url') {
        setError(t('admin.packageCard.errInvalidUrl'))
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    setBusy(false)
  }

  const doDelete = async (p: DownloadProvider) => {
    const id = rows[p].existingId
    if (!id) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await deleteDownloadSource(id)
      await reload()
      setNotice(t('admin.packageCard.removed', { name: providerLabel(p) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
    setConfirmDelete(null)
  }

  const liveCount = PROVIDERS.filter((p) => rows[p].existingId && rows[p].enabled).length

  return (
    <section className="max-w-xl space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-medium">{t('admin.packageCard.title')}</h2>
        {liveCount > 0 && (
          <Badge variant="default">{t('admin.packageCard.live', { n: liveCount })}</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('admin.packageCard.hint')}</p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner className="h-5 w-5" />
        </div>
      ) : (
        <div className="space-y-4">
          {PROVIDERS.map((p) => {
            const draft = rows[p]
            const isExisting = !!draft.existingId
            return (
              <div key={p} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{providerLabel(p)}</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={busy || !isExisting}
                      onChange={(e) => setDraft(p, { enabled: e.target.checked })}
                    />
                    {t('admin.packageCard.enabled')}
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-[240px] flex-1"
                    value={draft.url}
                    disabled={busy}
                    placeholder={urlPlaceholder(p)}
                    onChange={(e) => setDraft(p, { url: e.target.value })}
                  />
                  <Button size="sm" disabled={busy} onClick={() => save(p)}>
                    {t('admin.packageCard.save')}
                  </Button>
                  {isExisting && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => setConfirmDelete(p)}
                    >
                      {t('admin.packageCard.remove')}
                    </Button>
                  )}
                </div>
                {isExisting && (
                  <p className="text-[11px] text-muted-foreground">{t('admin.packageCard.existsHint')}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('admin.packageCard.deleteTitle', { name: confirmDelete ? providerLabel(confirmDelete) : '' })}
        destructive
        confirmLabel={t('admin.packageCard.remove')}
        description={t('admin.packageCard.deleteBody')}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && doDelete(confirmDelete)}
      />
    </section>
  )
}
