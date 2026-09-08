import { useEffect, useState } from 'react'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { useToast } from '@/components/ToastProvider'
import { Spinner } from '@/components/spinner'
import { Button } from '@/components/ui/button'

/**
 * V1.3.1 跟进（F3）：管理员备注 Dialog。
 * 存储 = user_admin_notes（0018：RLS 仅 is_admin()；普通用户严格不可见）；
 * 写入经 RLS upsert（updated_by=auth.uid() 自动），审计由触发器落 users.notes_updated。
 */
export function UserNotesDialog({
  userId,
  displayName,
  onClose,
}: {
  userId: string
  displayName: string
  onClose: () => void
}) {
  const { t } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const [notes, setNotes] = useState<string | null>(null) // null = 加载中
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { supabase } = await import('@/lib/supabase/client')
        const { data, error } = await supabase
          .from('user_admin_notes')
          .select('notes')
          .eq('user_id', userId)
          .maybeSingle()
        if (error) throw error
        if (!cancelled) {
          setNotes(data?.notes ?? '')
          setValue(data?.notes ?? '')
        }
      } catch {
        if (!cancelled) setNotes('') // 读取失败按空处理，保存仍可覆盖
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const save = async () => {
    setBusy(true)
    try {
      const { supabase } = await import('@/lib/supabase/client')
      const { error } = await supabase.from('user_admin_notes').upsert(
        { user_id: userId, notes: value.trim(), updated_by: user?.id ?? null },
        { onConflict: 'user_id' },
      )
      if (error) throw error
      toast.success(t('admin.usersPage.notesSaved'))
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('admin.credits.toastFailed'))
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div
        className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="text-lg font-semibold">{t('admin.usersPage.notesTitle', { name: displayName })}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('admin.usersPage.notesHint')}</p>
        {notes === null ? (
          <div className="flex justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : (
          <textarea
            className="mt-3 min-h-32 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            maxLength={2000}
            value={value}
            placeholder={t('admin.usersPage.notesPlaceholder')}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy || notes === null || value.trim() === (notes ?? '')} onClick={save}>
            {busy ? <Spinner className="h-4 w-4" /> : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
