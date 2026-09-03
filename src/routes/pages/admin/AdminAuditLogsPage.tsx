import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { AuditLogRow } from '@/types/database'
import { useAuth } from '@/features/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'

const PAGE_SIZE = 50

const FILTERS: Array<{ label: string; prefix: string }> = [
  { label: 'All', prefix: '' },
  { label: 'asset.', prefix: 'asset.' },
  { label: 'image.', prefix: 'image.' },
  { label: 'tag.', prefix: 'tag.' },
  { label: 'user.', prefix: 'user.' },
  { label: 'download_source.', prefix: 'download_source.' },
]

function fmtTime(s: string): string {
  return new Date(s).toLocaleString()
}

/** Audit Logs：admin JWT 直连 audit_logs（RLS is_admin；D4，不新增 Worker 读端点） */
export function AdminAuditLogsPage() {
  const { isAdmin } = useAuth()
  const [rows, setRows] = useState<AuditLogRow[] | null>(null)
  const [actors, setActors] = useState<Map<string, string>>(new Map())
  const [filter, setFilter] = useState('')
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 把审计行里的 actor_id 批量解析成 display_name（RLS 允许 admin 读 profiles）
  const enrichActors = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', ids)
    if (!err) {
      setActors((prev) => {
        const next = new Map(prev)
        for (const p of (data ?? []) as Array<{ id: string; display_name: string | null }>) {
          next.set(p.id, p.display_name?.trim() || '(unnamed)')
        }
        return next
      })
    }
  }, [])

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true)
      setError(null)
      try {
        let query = supabase
          .from('audit_logs')
          .select('*')
          .order('created_at', { ascending: false })
        if (filter) query = query.like('action', `${filter}%`)
        const { data, error: err } = await query.range(offset, offset + PAGE_SIZE - 1)
        if (err) throw new Error(err.message)
        const pageRows = (data ?? []) as AuditLogRow[]
        setRows((prev) => (append ? [...(prev ?? []), ...pageRows] : pageRows))
        setHasMore(pageRows.length === PAGE_SIZE)
        await enrichActors(
          pageRows.map((r) => r.actor_id).filter((v): v is string => !!v),
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
      setLoading(false)
    },
    [filter, enrichActors],
  )

  useEffect(() => {
    if (isAdmin) {
      setRows(null)
      void fetchPage(0, false)
    }
  }, [isAdmin, fetchPage])

  if (!isAdmin) return <p className="text-sm text-destructive">Admin only.</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Audit Logs</h1>
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.prefix}
              size="sm"
              variant={filter === f.prefix ? 'default' : 'outline'}
              onClick={() => setFilter(f.prefix)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            没有审计记录。
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Actor</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {fmtTime(r.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div>{actors.get(r.actor_id ?? '') ?? '—'}</div>
                      {r.actor_id && (
                        <div className="text-xs text-muted-foreground">
                          {r.actor_id.slice(0, 8)}…
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.action}</code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-muted-foreground">{r.target_type}</div>
                      {r.target_id && <div className="truncate text-xs">{r.target_id}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {r.metadata ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground hover:underline">
                            JSON
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                            {JSON.stringify(r.metadata, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {rows && rows.length > 0 && hasMore && (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => fetchPage(rows.length, true)}
          >
            {loading ? <Spinner className="mr-1 h-4 w-4" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
