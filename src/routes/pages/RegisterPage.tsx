import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import { registerViaWorker, RegisterError } from '@/features/auth/api'
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
 * 注册流程（Phase C PC-5：入口经 Worker gate，前端不建会话）：
 * - 提交经 POST /api/auth/register（Worker 服务端校验 + gate registration_enabled）；
 *   开关关闭 → 403 registration_disabled → 保留按钮、点击提示"当前暂未开放注册"。
 * - 建号成功后复用现有登录链路 supabase.auth.signInWithPassword 建立会话（PD-1 方案 A）：
 *   成功进站；若随后后端开启邮箱确认导致自动登录失败 → 回落"请查收邮件"页。
 * profiles / user_roles('user') 由数据库触发器 handle_new_user 自动创建，前端不写。
 * 残余风险（PD-3 已批 A）：anon key 直连 GoTrue /signup 仍可绕过本 gate，本轮接受、记录在案。
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

    // 1) 经 Worker gate 建号（不建会话、不回传 token）
    try {
      await registerViaWorker(email.trim(), password)
    } catch (err) {
      // disabled → 提示"暂未开放注册"（保留表单/按钮）；failed → 通用失败（不泄露邮箱是否存在）
      setFieldError(err instanceof RegisterError && err.kind === 'disabled'
        ? t('auth.registrationUnavailable')
        : t('auth.registerFailed'))
      setSubmitting(false)
      return
    }

    // 2) 复用现有登录链路建立会话（PD-1 方案 A；沿用 GoTrue 现状：邮箱确认关闭即直接进站）
    const { error: loginErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (loginErr) {
      // 建号成功但自动登录失败（例如后端随后开启邮箱确认）→ 回落"请查收邮件"页
      setPhase('check-email')
    } else {
      setPhase('signed-in') // AuthProvider 已捕获 session → 回跳 next
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
