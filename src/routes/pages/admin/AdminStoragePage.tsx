import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getAdminStats, type AdminStats } from '@/features/admin/api'
import { LANGUAGE_CODES, LANGUAGE_LABELS } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'

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

/** Storage 只读视图：与 Dashboard 同源一次 getAdminStats()（D5 标注估算口径） */
export function AdminStoragePage() {
  const { isAdmin } = useAuth()
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

  if (!isAdmin) return <p className="text-sm text-destructive">Admin only.</p>

  const langRows = LANGUAGE_CODES.map((code) => ({
    code,
    label: LANGUAGE_LABELS[code],
    count: stats?.imagesByLanguage?.[code] ?? 0,
  }))
  const maxLang = Math.max(1, ...langRows.map((r) => r.count))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Storage</h1>
        <Button size="sm" variant="outline" disabled={loading} onClick={reload}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
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
          <div className="rounded-md border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            用量口径：按数据库记录估算（SUM(images.file_size)），非 Storage 实查。
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Used</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{formatBytes(stats.storageUsedBytes)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Image Count</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{stats.totalImages}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Assets</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{stats.totalAssets}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By Language</CardTitle>
              <CardDescription>各语言图片数与估算用量来源（同一统计端点）</CardDescription>
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
                <p className="text-sm text-muted-foreground">还没有图片记录。</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
