import type { LanguageCode } from '@/types/database'

/**
 * V1.1 Phase B (PB-1)：GitHub 图片上传/删除（经 Worker，Gate 04 §9-5）
 * - 浏览器侧只持有自己的 JWT；GITHUB_TOKEN 仅在 Worker Secret（Gate §12 红线）
 * - 上传成功 = Worker 已完成 sha 校验并落 ready；失败即无对象/行公开可见
 * - 删除走四态闭环（ready → deleting → GitHub DELETE → 删行），远端失败由 sweeper 兜底
 */

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MAX_FILE_SIZE = 15 * 1024 * 1024

export function validateImageFile(file: File): void {
  if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
    throw new Error(`不支持的格式：${file.name}（仅 JPEG/PNG/WebP）`)
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大：${file.name}（上限 15 MB）`)
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabase/client')
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error('未登录，无法操作图片')
  return { Authorization: `Bearer ${jwt}` }
}

/** 经 Worker 上传到 GitHub（provider='github'）；返回 ready 行 id 与最终路径 */
export async function uploadImageGithub(
  assetLanguageId: string,
  file: File,
): Promise<{ imageId: string; sourcePath: string }> {
  validateImageFile(file)
  const headers = await authHeaders()

  const form = new FormData()
  form.append('file', file)
  form.append('asset_language_id', assetLanguageId)

  const res = await fetch('/api/admin/images/github-upload', {
    method: 'POST',
    headers,
    body: form,
  })
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; image_id?: string; source_path?: string; error?: { code?: string; message?: string } }
    | null
  if (!res.ok || !body?.ok || !body.image_id) {
    throw new Error(body?.error?.message ?? `上传失败（HTTP ${res.status}）`)
  }
  return { imageId: body.image_id, sourcePath: body.source_path ?? '' }
}

/**
 * 经 Worker 删除 GitHub 图片（四态闭环）。
 * 返回 deleted=true = 远端与 DB 行均已收敛；
 * 返回 deleted=false = 行保留 deleting/failed，由 sweeper 继续收敛（非调用方错误）。
 */
export async function deleteGithubImage(imageId: string): Promise<{ deleted: boolean }> {
  const headers = await authHeaders()
  const res = await fetch('/api/admin/images/github-delete', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageId }),
  })
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; deleted?: boolean; error?: { code?: string; message?: string } }
    | null
  if (!res.ok) {
    // not_deletable（failed 等无远端对象态）→ 调用方可退回行级删除
    const err = new Error(body?.error?.message ?? `删除失败（HTTP ${res.status}）`) as Error & { code?: string }
    err.code = body?.error?.code
    throw err
  }
  return { deleted: body?.deleted === true }
}

/** 语言码类型仅用于语义提示；路径由 Worker 按 UUID 规范生成 */
export type GithubUploadLang = LanguageCode
