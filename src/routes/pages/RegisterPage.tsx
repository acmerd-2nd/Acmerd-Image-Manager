import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import {
  PASSWORD_MIN_LENGTH,
  sanitizeInternalRedirect,
  validatePassword,
} from '@/lib/validators'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'

type RegisterPhase = 'form' | 'check-email' | 'signed-in'

/**
 * 注册流程（唯一事实来源是 Supabase Auth 返回值，前端不做任何兜底写入）：
 * - 返回 session        → 邮箱验证已关闭，直接进站
 * - 返回 user 无 session → 邮箱验证开启中，显示"请查收邮件"
 * profiles / user_roles('user') 由数据库触发器 handle_new_user 自动创建，
 * 前端不 INSERT、不 UPDATE —— 见 supabase/migrations/0001_initial_schema.sql
 * （Phase C PC-5 将把注册入口切到 Worker gate；本页先完成 PC-1 i18n 接线）
 */
export function RegisterPage() {
  const [searchParams] = useSearchParams()
  const { session, loading } = useAuth()
  const { t } = useLocale()

  const next = sanitizeInternalRedirect(searchParams.get('next')) ?? '/'

  const [phase, setPhase] = useState<RegisterPhase>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 已登录访问 /register → 回跳
  if (!loading && session) return <Navigate to={next} replace />

  const passwordHint = password
    ? (() => {
        const check = validatePassword(password)
        if (check.ok) return null
        return check.reason === 'too_short'
          ? t('auth.pwTooShort', { n: PASSWORD_MIN_LENGTH })
          : t('auth.pwNeedClasses')
      })()
    : null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setFieldError(null)

    // 提交前二次校验（输入过程中已有实时提示）
    const pwCheck = validatePassword(password)
    if (!pwCheck.ok) {
      setFieldError(
        pwCheck.reason === 'too_short'
          ? t('auth.pwTooShort', { n: PASSWORD_MIN_LENGTH })
          : t('auth.pwNeedClasses'),
      )
      return
    }
    if (password !== confirmPassword) {
      setFieldError(t('auth.pwMismatch'))
      return
    }

    setSubmitting(true)
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    })

    if (error) {
      // 不对错误做分类扩散：统一给出安全提示（不泄露邮箱是否已注册）
      setFieldError(t('auth.registerFailed'))
      setSubmitting(false)
      return
    }

    // 注册成功 —— 按 Supabase 返回值分支（保留既有行为，不改判断依据）
    if (data.session) {
      setPhase('signed-in') // 邮箱验证已关，session 已建立
    } else {
      setPhase('check-email') // 邮箱验证开启中，等待用户查收邮件
    }
    setSubmitting(false)
  }

  if (phase === 'check-email') {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
        <Card>
          <CardHeader className="text-center">
            <CardTitle>{t('auth.checkEmailTitle')}</CardTitle>
            <CardDescription>{t('auth.checkEmailTitle')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center text-sm text-muted-foreground">
            <p>
              {t('auth.checkEmailSent', { email: email.trim() })}
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">{t('auth.goToLogin')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (phase === 'signed-in') {
    // AuthProvider 的 onAuthStateChange 已捕获 session；直接回跳
    return <Navigate to={next} replace />
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.registerTitle')}</CardTitle>
          <CardDescription>{t('auth.registerSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="register-email" className="text-sm font-medium">
                {t('auth.email')}
              </label>
              <Input
                id="register-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="register-password" className="text-sm font-medium">
                {t('auth.password')}
              </label>
              <Input
                id="register-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {passwordHint && <p className="text-xs text-destructive">{passwordHint}</p>}
              {!passwordHint && password && (
                <p className="text-xs text-muted-foreground">
                  {t('auth.pwNeedClasses')} ✓
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="register-password-confirm" className="text-sm font-medium">
                {t('auth.confirmPassword')}
              </label>
              <Input
                id="register-password-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            {fieldError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {fieldError}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Spinner className="h-4 w-4" /> : t('auth.registerBtn')}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.hasAccount')}{' '}
            <Link
              to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('auth.loginBtn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
