import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/spinner'

/**
 * V1.2-C D9：密码找回请求页（GoTrue 原生流，零 Worker 端点）。
 * redirectTo 只取本文件常量（同源绝对地址），绝不拼接用户输入（D10 代码侧防线）。
 * 发送成功不回显邮箱是否存在（防枚举），统一展示"已发送"态。
 */
const CONFIRM_PATH = '/reset-password/confirm'

export function ResetPasswordPage() {
  const { t } = useLocale()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [rateLimited, setRateLimited] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setRateLimited(false)
    setSubmitting(true)
    try {
      const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}${CONFIRM_PATH}`,
      })
      if (authError) {
        const m = (authError.message ?? '').toLowerCase()
        if (authError.status === 429 || m.includes('too many requests') || m.includes('rate limit')) {
          setRateLimited(true)
        } else {
          // 非 429 失败同样收敛为通用态（GoTrue 对不存在邮箱也走静默分支；这里只防实现性错误惊吓用户）
          setSent(true)
        }
      } else {
        setSent(true)
      }
    } catch {
      setSent(true)
    }
    setSubmitting(false)
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{t('auth.resetTitle')}</CardTitle>
          <CardDescription>{t('auth.resetSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm">{t('auth.resetSent')}</p>
              <Link to="/login" className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
                {t('auth.goToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="reset-email" className="text-sm font-medium">
                  {t('auth.email')}
                </label>
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              {rateLimited && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {t('auth.rateLimited')}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={submitting || !email.trim()}>
                {submitting ? <Spinner className="h-4 w-4" /> : t('auth.resetSendBtn')}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="underline-offset-4 hover:underline">
                  {t('auth.backToLogin')}
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
