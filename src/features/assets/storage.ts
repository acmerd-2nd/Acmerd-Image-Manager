import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'
import type { LanguageCode } from '@/types/database'

/**
 * Phase 3 Storage 访问（权限通道按 Owner 裁决）：
 * - 上传：admin 浏览器用自身 JWT 直传（Storage RLS is_admin() 兜底）
 * - 删除：一律经 Worker POST /api/admin/storage/delete —— 浏览器侧不持有
 *   任何高权限凭据，Service Role Key 只存在于 Worker Secret
 */

export const MAX_FILE_SIZE = 15 * 1024 * 1024 // 与 bucket 配置一致
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const

export class FileValidationError extends Error {}

export function validateImageFile(file: File): void {
  if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
    throw new FileValidationError(t('download.fileBadFormat', { name: file.type || file.name }))
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new FileValidationError(t('download.fileTooLarge', { name: file.name }))
  }
}

function uuid8(): string {
  return crypto.randomUUID().slice(0, 8)
}

function extOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
}

/** 直传一个图片对象，返回完整 storage_path（含 bucket 名，与 DB 约定一致） */
export async function uploadImage(
  assetId: string,
  lang: LanguageCode,
  seq: number,
  file: File,
): Promise<string> {
  validateImageFile(file)
  const path = `images/${assetId}/${lang}/${String(seq).padStart(2, '0')}-${uuid8()}.${extOf(file)}`
  const { error } = await supabase.storage
    .from('images')
    .upload(path.replace(/^images\//, ''), file, {
      contentType: file.type,
      // Phase 9 D5：路径含 uuid8() 随机段 + upsert:false → 唯一不可变对象，可安全 immutable。
      // cacheControl 直接作为对象的 cache-control 响应头（仅作用于新上传；历史对象不批量迁移）。
      cacheControl: 'public, max-age=31536000, immutable',
      upsert: false,
    })
  if (error) throw new Error(error.message)
  return path
}

/**
 * 请求 Worker 删除 Storage 对象（精确路径白名单见 worker/index.ts）。
 * 携带调用者自己的 JWT；Worker 验证 admin 后用 Service Role 执行删除。
 * 注意：必须传完整 storage_path（含 bucket 名，与 DB 约定一致）；
 * 目录级前缀删除不可靠（Storage 不递归 + list 有缓存），一律精确路径。
 */
export async function deleteStoragePaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error(t('download.loginRequired'))

  const res = await fetch('/api/admin/storage/delete', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paths }),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? t('download.storageDeleteFailed', { status: res.status }))
  }
}
