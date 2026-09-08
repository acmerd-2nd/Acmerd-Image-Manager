import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronLeft, ChevronRight, MoreHorizontal, NotebookText } from 'lucide-react'
import {
  batchAdjustCredits,
  changeUserRole,
  listAdminUsers,
  setUserDisabled,
  updateUserCredits,
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ToastProvider'
import { CreditsAdjustDialog } from './CreditsAdjustDialog'
import { UserNotesDialog } from './UserNotesDialog'

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

/**
 * V1.3.1：Users 页重构。
 * - G3：积分列 = 余额展示（♾ 标注 unlimited）+「调整」按钮 → CreditsAdjustDialog（快捷 ± / Set Balance / Unlimited）
 * - G4：行首复选框 → 批量条（变动额 + 原因 + 二次确认），整批成功或整批失败（Worker/RPC 保证）
 * - G5：操作列收敛为 ⋯ 菜单（调整积分 / 角色 / 禁用·启用）
 */
export function AdminUsersPage() {
  const { t } = useLocale()
  const { isAdmin, user } = useAuth()
  const toast = useToast()
  const [envelope, setEnvelope] = useState<AdminUsersEnvelope | null>(null)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<AdminUserSummary | null>(null)
  // PC-4：credits 状态（envelope 无此字段，单独按页维护；key=userId）
  const [creditsMap, setCreditsMap] = useState<Map<string, { balance: number; unlimited: boolean }> | null>(null)
  // V1.3.1：积分调整 Dialog / 行菜单 / 批量选择 / 备注
  const [creditTarget, setCreditTarget] = useState<AdminUserSummary | null>(null)
  const [notesTarget, setNotesTarget] = useState<AdminUserSummary | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchDelta, setBatchDelta] = useState('')
  const [batchReason, setBatchReason] = useState('')
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  const reload = useCallback(async (p: number) => {
    setError(null)
    try {
      const env = await listAdminUsers({ page: p, perPage: PAGE_SIZE })
      setEnvelope(env)
      setPage(env.page)
      setSelected(new Set())
      // PC-4：拉取本页用户 credits（admin RLS 可读 credit_accounts；envelope 无此字段）
      try {
        const { supabase } = await import('@/lib/supabase/client')
        const ids = env.users.map((u) => u.id)
        if (ids.length > 0) {
          const { data } = await supabase
            .from('credit_accounts')
            .select('user_id, balance, unlimited')
            .in('user_id', ids)
          const m = new Map<string, { balance: number; unlimited: boolean }>()
          for (const row of (data ?? []) as Array<{ user_id: string; balance: string | number; unlimited: boolean }>) {
            m.set(row.user_id, { balance: Number(row.balance), unlimited: row.unlimited })
          }
          setCreditsMap(m)
        } else {
          setCreditsMap(new Map())
        }
      } catch {
        setCreditsMap(null) // 读取失败列显示 —
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) reload(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, page])

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload(page)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const isSelf = (u: AdminUserSummary): boolean => !!user && u.id === user.id

  const onMakeAdmin = (u: AdminUserSummary) => run(() => changeUserRole(u.id, 'admin'))

  const onDemote = (u: AdminUserSummary) => run(() => changeUserRole(u.id, 'user'))

  const onEnable = (u: AdminUserSummary) => run(() => setUserDisabled(u.id, false))

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

  // G4：批量调整（整批成功或整批失败，由 admin_batch_adjust_credits RPC 保证）
  const parsedBatchDelta = Number(batchDelta)
  const batchOk =
    selected.size > 0 &&
    Number.isFinite(parsedBatchDelta) &&
    parsedBatchDelta !== 0 &&
    batchReason.trim().length > 0

  const onBatchConfirm = async () => {
    if (!batchOk) return
    setBatchBusy(true)
    setError(null)
    try {
      await batchAdjustCredits([...selected], parsedBatchDelta, batchReason.trim())
      setBatchConfirmOpen(false)
      setBatchDelta('')
      setBatchReason('')
      toast.success(t('admin.usersPage.batchDone', { n: selected.size, delta: (parsedBatchDelta > 0 ? '+' : '') + parsedBatchDelta }))
      await reload(page)
    } catch (e) {
      setBatchConfirmOpen(false)
      setError(e instanceof Error ? e.message : String(e))
      toast.error(t('admin.credits.toastFailed'))
    }
    setBatchBusy(false)
  }

  const toggleRow = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // V1.3.1 跟进（F1/F2）：列表列直接切换 Unlimited（苹果 Switch；写路径仍 Worker 独占）
  const onToggleUnlimited = async (u: AdminUserSummary, next: boolean) => {
    setTogglingId(u.id)
    setError(null)
    try {
      await updateUserCredits(u.id, { unlimited: next, reason: 'admin_toggle_unlimited', operation: 'toggle_unlimited' })
      toast.success(next ? t('admin.credits.toastUnlimitedOn') : t('admin.credits.toastUnlimitedOff'))
      await reload(page)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toast.error(t('admin.credits.toastFailed'))
    }
    setTogglingId(null)
  }

  const pageUserIds = envelope?.users.map((u) => u.id) ?? []
  const allChecked = pageUserIds.length > 0 && pageUserIds.every((id) => selected.has(id))

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

      {/* G4：批量调整条 */}
      {selected.size > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="text-sm font-medium">{t('admin.usersPage.batchSelected', { n: selected.size })}</div>
            <div>
              <label htmlFor="batch-delta" className="mb-1 block text-xs text-muted-foreground">
                {t('admin.usersPage.batchAmount')}
              </label>
              <Input
                id="batch-delta"
                className="h-8 w-28"
                inputMode="numeric"
                placeholder="+50"
                value={batchDelta}
                onChange={(e) => setBatchDelta(e.target.value)}
              />
            </div>
            <div className="min-w-48 flex-1">
              <label htmlFor="batch-reason" className="mb-1 block text-xs text-muted-foreground">
                {t('admin.credits.reasonLabel')}
              </label>
              <Input
                id="batch-reason"
                className="h-8"
                value={batchReason}
                maxLength={200}
                placeholder={t('admin.usersPage.batchReasonPlaceholder')}
                onChange={(e) => setBatchReason(e.target.value)}
              />
            </div>
            <Button size="sm" disabled={!batchOk || batchBusy} onClick={() => setBatchConfirmOpen(true)}>
              {batchBusy ? <Spinner className="h-4 w-4" /> : t('admin.usersPage.batchBtn')}
            </Button>
          </CardContent>
        </Card>
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
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={t('admin.usersPage.selectAll')}
                      checked={allChecked}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(pageUserIds) : new Set())
                      }
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colUser')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colRole')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.users.credits')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.users.toggleUnlimited')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colCreated')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.usersPage.colStatus')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('admin.usersPage.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {envelope.users.map((u, rowIdx) => {
                  const self = isSelf(u)
                  const credits = creditsMap?.get(u.id)
                  const isLastRow = rowIdx === envelope.users.length - 1
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label={displayNameOf(u)}
                          checked={selected.has(u.id)}
                          onChange={(e) => toggleRow(u.id, e.target.checked)}
                        />
                      </td>
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
                      <td className="px-4 py-3">
                        <span className="tabular-nums">
                          {credits ? credits.balance : '—'}
                          {credits?.unlimited ? ' ♾' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Switch
                          checked={credits?.unlimited ?? false}
                          disabled={!credits || togglingId === u.id}
                          aria-label={`${t('admin.users.toggleUnlimited')} · ${displayNameOf(u)}`}
                          onCheckedChange={(next) => onToggleUnlimited(u, next)}
                        />
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
                      <td className="relative px-4 py-3">
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('admin.usersPage.colActions')}
                            disabled={busy}
                            onClick={() => setMenuFor(menuFor === u.id ? null : u.id)}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </div>
                        {menuFor === u.id && (
                          <>
                            {/* 点击菜单外关闭 */}
                            <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />
                            <div className={`absolute right-4 z-50 w-44 rounded-md border bg-background py-1 shadow-lg ${isLastRow ? 'bottom-full mb-1' : 'top-full'}`}>
                              <button
                                type="button"
                                className="w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                                disabled={!credits}
                                onClick={() => {
                                  setMenuFor(null)
                                  setCreditTarget(u)
                                }}
                              >
                                {t('admin.usersPage.adjust')}
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                onClick={() => {
                                  setMenuFor(null)
                                  setNotesTarget(u)
                                }}
                              >
                                <NotebookText className="h-4 w-4 text-muted-foreground" />
                                {t('admin.usersPage.notes')}
                              </button>
                              {u.role === 'admin' ? (
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                                  disabled={busy || self}
                                  title={self ? t('admin.usersPage.selfDemote') : undefined}
                                  onClick={() => {
                                    setMenuFor(null)
                                    onDemote(u)
                                  }}
                                >
                                  {t('admin.usersPage.makeUser')}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => {
                                    setMenuFor(null)
                                    onMakeAdmin(u)
                                  }}
                                >
                                  {t('admin.usersPage.makeAdmin')}
                                </button>
                              )}
                              {u.disabled ? (
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                                  disabled={busy || self}
                                  title={self ? t('admin.usersPage.selfEnable') : undefined}
                                  onClick={() => {
                                    setMenuFor(null)
                                    onEnable(u)
                                  }}
                                >
                                  {t('admin.usersPage.enable')}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm text-destructive hover:bg-muted disabled:opacity-50"
                                  disabled={busy || self}
                                  title={self ? t('admin.usersPage.selfDisable') : undefined}
                                  onClick={() => {
                                    setMenuFor(null)
                                    setConfirmTarget(u)
                                  }}
                                >
                                  {t('admin.usersPage.disable')}
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* G3：积分调整 Dialog（快捷 ± / Set Balance / Unlimited） */}
      {creditTarget && (
        <CreditsAdjustDialog
          userId={creditTarget.id}
          displayName={displayNameOf(creditTarget)}
          balance={creditsMap?.get(creditTarget.id)?.balance ?? 0}
          unlimited={creditsMap?.get(creditTarget.id)?.unlimited ?? false}
          onClose={() => setCreditTarget(null)}
          onChanged={() => reload(page)}
        />
      )}

      {/* V1.3.1 跟进（F3）：管理员备注 Dialog */}
      {notesTarget && (
        <UserNotesDialog
          userId={notesTarget.id}
          displayName={displayNameOf(notesTarget)}
          onClose={() => setNotesTarget(null)}
        />
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

      {/* G4：批量二次确认 */}
      <ConfirmDialog
        open={batchConfirmOpen}
        title={t('admin.usersPage.batchConfirmTitle')}
        description={t('admin.usersPage.batchConfirmBody', {
          n: selected.size,
          delta: (parsedBatchDelta > 0 ? '+' : '') + parsedBatchDelta,
        })}
        confirmLabel={t('common.confirm')}
        onCancel={() => setBatchConfirmOpen(false)}
        onConfirm={onBatchConfirm}
      />
    </div>
  )
}
