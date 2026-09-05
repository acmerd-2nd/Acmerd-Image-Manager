import { t } from '@/i18n'

/**
 * V1.1 PC-5：注册入口公共客户端层。
 * 真正 gate 在 Worker（403 registration_disabled）；本层只做调用 + 错误归类，
 * 绝不建会话、不回传 token —— 注册成功后由 RegisterPage 复用 supabase.auth.signInWithPassword
 * 建立会话（PD-1 方案 A：沿用现有登录链路，AuthProvider 零改动）。
 */
export class RegisterError extends Error {
  kind: 'disabled' | 'failed'
  constructor(kind: 'disabled' | 'failed') {
    super(kind === 'disabled' ? t('auth.registrationUnavailable') : t('auth.registerFailed'))
    this.kind = kind
  }
}

/**
 * 调用 Worker POST /api/auth/register。
 * - 2xx → resolve（账号已建，未登录）
 * - 403 registration_disabled → RegisterError('disabled')
 * - 其余（400 invalid_input / registration_failed、5xx）→ RegisterError('failed')（不泄露具体原因）
 */
export async function registerViaWorker(email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.ok) return

  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
  if (res.status === 403 && body?.error?.code === 'registration_disabled') {
    throw new RegisterError('disabled')
  }
  throw new RegisterError('failed')
}
