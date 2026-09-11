import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'

/**
 * V1.8.0 头像自助接口。
 * 与合集封面同范式（multipart → Worker 写 GitHub → 落库），但走 /api/me/*：
 * userId 由 Worker 从 JWT 取，只能管理【自己】的头像；前端不传 id。
 */

async function authOnlyHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error(t('auth.avatar.loginRequired'))
  return { Authorization: `Bearer ${jwt}` }
}

export interface AvatarUploadResult {
  url: string
  path: string
}

/** 上传裁剪后的头像字节；成功返回可直链的 raw URL（已是最新版本，可立即用于展示）。 */
export async function uploadAvatar(file: File): Promise<AvatarUploadResult> {
  const headers = await authOnlyHeader()
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/me/avatar', { method: 'POST', headers, body: form })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; url?: string; path?: string; error?: { code?: string; message?: string } }
    | null
  if (!res.ok || !payload?.ok) {
    const err = new Error(
      payload?.error?.message ?? t('auth.avatar.requestFailed', { status: res.status }),
    ) as Error & { code?: string }
    err.code = payload?.error?.code
    throw err
  }
  return { url: payload.url ?? '', path: payload.path ?? '' }
}

/** 移除头像（Worker 删 GitHub 对象 + 清 profiles.avatar_url）。 */
export async function deleteAvatar(): Promise<void> {
  const headers = await authOnlyHeader()
  const res = await fetch('/api/me/avatar', { method: 'DELETE', headers })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: { code?: string; message?: string } }
    | null
  if (!res.ok || !payload?.ok) {
    const err = new Error(
      payload?.error?.message ?? t('auth.avatar.requestFailed', { status: res.status }),
    ) as Error & { code?: string }
    err.code = payload?.error?.code
    throw err
  }
}
