import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import { validatePassword } from '@/lib/validators'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'

/**
 * V1.2-C D9：密码确认页。恢复邮件链接回到本页时 detectSessionInUrl 消费
 * recovery token 建立 session（recovery 会话）；本页仅接受「会话内改密」。
 * 守卫：加载完成后仍无 session → 重定向回请求页（邮箱所有权即授权边界，无会话不展示表单）。
 * 成功后 signOut（recovery 会话不留存）→ 回 /login。
 */
export function ResetPasswordConfirmPage() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const { t } = useLocale()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // recovery token 由 supabase-js 在 URL 中检测消费；给 AuthProvider 一轮检测时间
  const [detecting, setDetecting] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setDetecting(false), 1500)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!loading) setDetecting(false)
  }, [loading])

  if (detecting || loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  // 无会话（链接过期/已用/非恢复链接直达）→ 回请求页
  if (!session) return <Navigate to="/reset-password" replace state={{ from: location.pathname }} />

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setFail(null)
    const v = validatePassword(password)
    if (!v.ok) {
      setFail(v.reason === 'too_short' ? t('auth.pwTooShort', { n: 8 }) : t('auth.pwNeedClasses'))
      return
    }
    if (password !== confirm) {
      setFail(t('auth.pwMismatch'))
      return
    }
    setSubmitting(true)
    const { error: authError } = await supabase.auth.updateUser({ password })
    setSubmitting(false)
    if (authError) {
      setFail(t('auth.resetFailed'))
      return
    }
    // 改密成功：撤销本 recovery 会话，走常规登录
    await supabase.auth.signOut()
    setDone(true)
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.resetConfirmTitle')}</CardTitle>
          <CardDescription>{t('auth.resetConfirmSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm">{t('auth.resetSuccess')}</p>
              <Link
                to="/login"
                className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('auth.goToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="reset-new-password" className="text-sm font-medium">
                  {t('auth.newPassword')}
                </label>
                <Input
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reset-confirm-password" className="text-sm font-medium">
                  {t('auth.confirmPassword')}
                </label>
                <Input
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              {fail && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {fail}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={submitting || !password || !confirm}>
                {submitting ? <Spinner className="h-4 w-4" /> : t('auth.resetConfirmBtn')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
