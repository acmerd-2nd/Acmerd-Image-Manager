import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  changeUserRole,
  listAdminUsers,
  setUserDisabled,
  type AdminUserSummary,
  type AdminUsersEnvelope,
} from '@/features/admin/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const PAGE_SIZE = 20

function displayNameOf(u: AdminUserSummary): string {
  return u.display_name?.trim() || u.email || '(unnamed)'
}

function initialOf(u: AdminUserSummary): string {
  return displayNameOf(u).trim().charAt(0).toUpperCase()
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleString() : '—'
}

/** Users：列表（分页，envelope 驱动）+ 改角色 + 禁用/启用；self 组合置灰 */
export function AdminUsersPage() {
  const { isAdmin, user } = useAuth()
  const [envelope, setEnvelope] = useState<AdminUsersEnvelope | null>(null)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<AdminUserSummary | null>(null)

  const reload = useCallback(async (p: number) => {
    setError(null)
    try {
      const env = await listAdminUsers({ page: p, perPage: PAGE_SIZE })
      setEnvelope(env)
      setPage(env.page)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) reload(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, page])

  if (!isAdmin) return <p className="text-sm text-destructive">Admin only.</p>

  const run = async (fn: () => Promise<unknown>, afterClear?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      afterClear?.()
      await reload(page)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const isSelf = (u: AdminUserSummary): boolean => !!user && u.id === user.id

  const onMakeAdmin = (u: AdminUserSummary) =>
    run(() => changeUserRole(u.id, 'admin'))

  const onDemote = (u: AdminUserSummary) =>
    run(() => changeUserRole(u.id, 'user'))

  const onEnable = (u: AdminUserSummary) =>
    run(() => setUserDisabled(u.id, false))

  const onDisableConfirmed = async () => {
    const target = confirmTarget
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await setUserDisabled(target.id, true)
      setConfirmTarget(null)
      await reload(page)
    } catch (e) {
      // 关闭对话框并展示服务端错误（如 last_admin / forbidden），用户可再决策
      setConfirmTarget(null)
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const totalPages = Math.max(1, Math.ceil((envelope?.total ?? 0) / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Users</h1>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !envelope || page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !envelope || page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reload(page)}>
            <RefreshCw className={`mr-1 h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {envelope
          ? `Page ${envelope.page} / ${totalPages} · 共 ${envelope.total} 位用户`
          : '加载用户列表…'}
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {envelope === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : envelope.users.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            没有匹配的用户。
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {envelope.users.map((u) => {
                  const self = isSelf(u)
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                            {initialOf(u)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {u.display_name?.trim() || '—'}
                              {self && (
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                  (you)
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {u.email ?? '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                          {u.role}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(u.created_at)}</td>
                      <td className="px-4 py-3">
                        {u.disabled ? (
                          <Badge variant="outline" className="text-destructive">
                            disabled
                          </Badge>
                        ) : (
                          <Badge variant="secondary">active</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {u.role === 'admin' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || self}
                              title={self ? '不能对自己执行降级' : undefined}
                              onClick={() => onDemote(u)}
                            >
                              Make user
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => onMakeAdmin(u)}
                            >
                              Make admin
                            </Button>
                          )}
                          {u.disabled ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || self}
                              title={self ? '不能对自己执行启用' : undefined}
                              onClick={() => onEnable(u)}
                            >
                              Enable
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy || self}
                              title={self ? '不能对自己执行禁用' : undefined}
                              onClick={() => setConfirmTarget(u)}
                            >
                              Disable
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        title={`禁用用户「${confirmTarget ? displayNameOf(confirmTarget) : ''}」？`}
        destructive
        confirmLabel="Disable"
        description={
          confirmTarget
            ? '禁用后该用户将无法访问任何 /api 接口并立即失去管理能力（禁用即时生效；会话撤销为 best-effort）。可随时重新启用。\n\n系统保留的最后一名活跃管理员不可被禁用。'
            : ''
        }
        onCancel={() => setConfirmTarget(null)}
        onConfirm={onDisableConfirmed}
      />
    </div>
  )
}
