import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'

/**
 * Phase 7 Admin Console —— Worker admin 端点客户端层。
 * 所有请求携带调用者自己的 JWT（Bearer），Worker 二次校验 admin + 未禁用（D2）。
 * 统一解码错误体 `{error:{code,message}}`，已知错误码经 i18n 转成本地化提示。
 * 审计读取不走本模块（D4）：admin 登录态经 RLS 直连 audit_logs。
 */

export type AdminRole = 'user' | 'admin'

export interface AdminUserSummary {
  id: string
  email: string | null
  display_name: string | null
  role: AdminRole
  disabled: boolean
  created_at: string | null
  last_sign_in_at: string | null
}

export interface AdminUsersEnvelope {
  users: AdminUserSummary[]
  total: number
  page: number
  per_page: number
}

export interface AdminStats {
  totalAssets: number
  assetsByStatus: Record<string, number>
  totalImages: number
  totalUsers: number
  disabledUsers: number
  storageUsedBytes: number
  imagesByLanguage: Record<string, number>
}

export interface AdminUserMutationResult {
  user_id: string
  role: AdminRole
  disabled: boolean
  role_changed: boolean
  disabled_changed: boolean
}

export class AdminApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code = 'error') {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
  }
}

/** 已知错误码 → 本地化提示（account_disabled / last_admin / forbidden 等需覆盖文案） */
function toUserMessage(code: string, serverMsg: string | null, status: number): string {
  switch (code) {
    case 'account_disabled':
      return t('admin.api.accountDisabled')
    case 'last_admin':
      return t('admin.api.lastAdmin')
    case 'forbidden':
      return t('admin.api.forbiddenSelf')
    case 'not_found':
      return t('admin.api.userNotFound')
    case 'bad_request':
      return t('admin.api.badRequest')
    case 'unauthorized':
      return t('admin.api.unauthorized')
    case 'upstream_error':
      return t('admin.api.upstreamError')
    default:
      return serverMsg?.trim() ? serverMsg : t('admin.api.requestFailed', { status })
  }
}

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/** 统一 fetch Worker admin 端点 + 解码 `{error:{code,message}}` */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const jwt = await getJwt()
  if (!jwt) throw new AdminApiError(t('admin.api.unauthorized'), 401, 'unauthorized')

  const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` }
  if (init.body) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    const code = body?.error?.code ?? 'error'
    const serverMsg = body?.error?.message ?? null
    throw new AdminApiError(toUserMessage(code, serverMsg, res.status), res.status, code)
  }
  return (await res.json()) as T
}

/** GET /api/admin/users?page=&per_page= —— 返回自包含 envelope（含 total/page/per_page） */
export async function listAdminUsers(
  params: { page?: number; perPage?: number } = {},
): Promise<AdminUsersEnvelope> {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const perPage = Math.min(100, Math.max(1, Math.floor(params.perPage ?? 20)))
  return request<AdminUsersEnvelope>(`/api/admin/users?page=${page}&per_page=${perPage}`)
}

/** POST /api/admin/users/:userId/role —— body {role:'user'|'admin'} */
export async function changeUserRole(
  userId: string,
  role: AdminRole,
): Promise<AdminUserMutationResult> {
  return request<AdminUserMutationResult>(`/api/admin/users/${userId}/role`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  })
}

/** POST /api/admin/users/:userId/disabled —— body {disabled:boolean} */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
): Promise<AdminUserMutationResult> {
  return request<AdminUserMutationResult>(`/api/admin/users/${userId}/disabled`, {
    method: 'POST',
    body: JSON.stringify({ disabled }),
  })
}

/** GET /api/admin/stats —— 单一聚合端点（7 键透传） */
export async function getAdminStats(): Promise<AdminStats> {
  return request<AdminStats>('/api/admin/stats')
}
