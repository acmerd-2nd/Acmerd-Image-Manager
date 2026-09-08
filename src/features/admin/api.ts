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

// ---------------- V1.1 PC-3/PC-6：平台设置（写仅经 Worker；公开读走 0011 anon grants） ----------------

export interface PlatformSettings {
  registration_enabled: boolean
  schedule_navigation_enabled: boolean
  single_image_download_cost: number
  zip_download_cost_per_image: number
  package_download_cost: number
  brand_text: string
  brand_title: string
  brand_logo_path: string
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const payload = await request<{ ok: boolean; settings: Record<string, unknown> }>('/api/admin/settings')
  const s = payload.settings
  return {
    registration_enabled: s.registration_enabled === true,
    schedule_navigation_enabled: s.schedule_navigation_enabled === true,
    single_image_download_cost: Number(s.single_image_download_cost ?? 1),
    zip_download_cost_per_image: Number(s.zip_download_cost_per_image ?? 1),
    package_download_cost: Number(s.package_download_cost ?? 15),
    brand_text: typeof s.brand_text === 'string' ? s.brand_text : 'ACMERD · 探知',
    brand_title: typeof s.brand_title === 'string' ? s.brand_title : 'ACMERD · 探知',
    brand_logo_path: typeof s.brand_logo_path === 'string' ? s.brand_logo_path : '',
  }
}

export async function updatePlatformSettings(
  patch: Partial<PlatformSettings>,
): Promise<void> {
  await request<{ ok: boolean }>('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({ settings: patch }),
  })
}

/** PC-4：Admin 设定用户余额/无限积分（balance=设定值语义；unlimited 可只传其一） */
export async function updateUserCredits(
  userId: string,
  patch: { balance?: number; unlimited?: boolean; reason?: string; operation?: string },
): Promise<void> {
  await request<{ ok: boolean }>(`/api/admin/users/${userId}/credits`, {
    method: 'POST',
    body: JSON.stringify(patch),
  })
}

/** V1.3.1 G4：批量调整积分（整批原子——任一用户失败则全部不生效） */
export async function batchAdjustCredits(
  userIds: string[],
  delta: number,
  reason: string,
): Promise<{ adjusted: number; delta: number }> {
  return request<{ ok: boolean; adjusted: number; delta: number }>('/api/admin/users/credits/batch', {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds, delta, reason }),
  })
}

// ---------------- V1.4：站点品牌 Logo（GitHub 图仓库；写仅经 Worker admin 端点） ----------------

export interface BrandLogoResult {
  ok: boolean
  path: string
}

export interface BrandLogoDeleteResult {
  ok: boolean
  removed: string | null
  github_deleted: boolean
}

/** POST /api/admin/branding/logo —— multipart(file) 上传站点 Logo（≤1MB JPEG/PNG/WebP） */
export async function uploadBrandLogo(file: File): Promise<BrandLogoResult> {
  const jwt = await getJwt()
  if (!jwt) throw new AdminApiError(t('admin.api.unauthorized'), 401, 'unauthorized')
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/admin/branding/logo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const code = body?.error?.code ?? 'error'
    throw new AdminApiError(toUserMessage(code, body?.error?.message ?? null, res.status), res.status, code)
  }
  return (await res.json()) as BrandLogoResult
}

/** DELETE /api/admin/branding/logo —— 移除站点 Logo（GitHub 对象 + 清空 setting） */
export async function deleteBrandLogo(): Promise<BrandLogoDeleteResult> {
  const jwt = await getJwt()
  if (!jwt) throw new AdminApiError(t('admin.api.unauthorized'), 401, 'unauthorized')
  const res = await fetch('/api/admin/branding/logo', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const code = body?.error?.code ?? 'error'
    throw new AdminApiError(toUserMessage(code, body?.error?.message ?? null, res.status), res.status, code)
  }
  return (await res.json()) as BrandLogoDeleteResult
}
