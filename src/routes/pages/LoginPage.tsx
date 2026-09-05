import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import { sanitizeInternalRedirect } from '@/lib/validators'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'

/** 错误分桶：凭据错误 / 未验证 / 限速 / 其他 */
type LoginError =
  | { kind: 'credentials' }
  | { kind: 'not_confirmed'; email: string }
  | { kind: 'rate_limit' }
  | { kind: 'unknown'; detail: string }

function bucketLoginError(status: number | undefined, message: string, code?: string): LoginError {
  const m = message.toLowerCase()
  if (code === 'invalid_credentials' || m.includes('invalid login credentials')) {
    return { kind: 'credentials' }
  }
  if (code === 'email_not_confirmed' || m.includes('email not confirmed')) {
    return { kind: 'not_confirmed', email: '' } // email 由调用方补齐
  }
  if (status === 429 || m.includes('too many requests') || code === 'over_request_rate_limit') {
    return { kind: 'rate_limit' }
  }
  return { kind: 'unknown', detail: message }
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { session, loading } = useAuth()
  const { t } = useLocale()

  // ?next= 白名单校验；守卫带回的 state.from 也可作为回跳来源
  const stateFrom =
    typeof (location.state as { from?: unknown } | null)?.from === 'string'
      ? (location.state as { from: string }).from
      : null
  const next =
    sanitizeInternalRedirect(searchParams.get('next')) ??
    sanitizeInternalRedirect(stateFrom) ??
    '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<LoginError | null>(null)

  // 已登录访问 /login → 回跳
  if (!loading && session) return <Navigate to={next} replace />

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (authError) {
      const bucketed = bucketLoginError(authError.status, authError.message, authError.code)
      if (bucketed.kind === 'not_confirmed') bucketed.email = email.trim()
      setError(bucketed)
      setSubmitting(false)
      return
    }

    // 成功：AuthProvider 会通过 onAuthStateChange 更新，这里直接跳转
    navigate(next, { replace: true })
  }

  const handleResendConfirmation = async () => {
    if (!error || error.kind !== 'not_confirmed') return
    await supabase.auth.resend({ type: 'signup', email: error.email })
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.loginTitle')}</CardTitle>
          <CardDescription>{t('auth.loginSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-sm font-medium">
                {t('auth.email')}
              </label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-sm font-medium">
                {t('auth.password')}
              </label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error.kind === 'credentials' && <p>{t('auth.credentialsError')}</p>}
                {error.kind === 'not_confirmed' && (
                  <div className="space-y-1">
                    <p>{t('auth.notConfirmed')}</p>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-destructive underline"
                      onClick={handleResendConfirmation}
                    >
                      {t('auth.resendConfirmation')}
                    </Button>
                  </div>
                )}
                {error.kind === 'rate_limit' && <p>{t('auth.rateLimited')}</p>}
                {error.kind === 'unknown' && <p>{t('common.error')}</p>}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Spinner className="h-4 w-4" /> : t('auth.loginBtn')}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link
              to={next === '/' ? '/register' : `/register?next=${encodeURIComponent(next)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('auth.gotoRegister')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
