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
import { useLocale, t as tStatic } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const PAGE_SIZE = 20

function displayNameOf(u: AdminUserSummary): string {
  return u.display_name?.trim() || u.email || tStatic('adminExtra.unnamed')
}

function initialOf(u: AdminUserSummary): string {
  return displayNameOf(u).trim().charAt(0).toUpperCase()
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleString() : '—'
}

/** Users：列表（分页，envelope 驱动）+ 改角色 + 禁用/启用；self 组合置灰 */
export function AdminUsersPage() {
  const { t } = useLocale()
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

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

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
        <h1 className="text-xl font-semibold">{t('admin.page.users')}</h1>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !envelope || page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t('pagination.prev')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !envelope || page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('pagination.next')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reload(page)}>
            <RefreshCw className={`mr-1 h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            {t('admin.refresh')}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {envelope
          ? t('admin.usersPage.pageOf', { page: envelope.page, total: totalPages, count: envelope.total })
          : t('admin.usersPage.loading')}
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
            {t('admin.usersPage.noMatching')}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colUser')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colRole')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colCreated')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colStatus')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('admin.usersPage.colActions')}</th>
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
                                  {'(' + t('admin.usersPage.you') + ')'}
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
                            {t('admin.usersPage.disabled')}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t('admin.usersPage.active')}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {u.role === 'admin' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || self}
                              title={self ? t('admin.usersPage.selfDemote') : undefined}
                              onClick={() => onDemote(u)}
                            >
                              {t('admin.usersPage.makeUser')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => onMakeAdmin(u)}
                            >
                              {t('admin.usersPage.makeAdmin')}
                            </Button>
                          )}
                          {u.disabled ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || self}
                              title={self ? t('admin.usersPage.selfEnable') : undefined}
                              onClick={() => onEnable(u)}
                            >
                              {t('admin.usersPage.enable')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy || self}
                              title={self ? t('admin.usersPage.selfDisable') : undefined}
                              onClick={() => setConfirmTarget(u)}
                            >
                              {t('admin.usersPage.disable')}
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
        title={t('admin.usersPage.disableTitle', { name: confirmTarget ? displayNameOf(confirmTarget) : '' })}
        destructive
        confirmLabel={t('admin.usersPage.disable')}
        description={confirmTarget ? t('admin.usersPage.disableBody') : ''}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={onDisableConfirmed}
      />
    </div>
  )
}
