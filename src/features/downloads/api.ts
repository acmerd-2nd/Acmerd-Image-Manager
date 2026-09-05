import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'

/**
 * Phase 5 下载通道（三套独立机制的公共客户端层）。
 * 单图 / ZIP 经 Worker（携带用户自己的 JWT，服务端二次校验角色与发布状态）；
 * Package 走 RLS 直连查询 + 前端安全校验后 window.open。
 */

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/** 触发浏览器另存（blob → a[download]） */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 从响应头 Content-Disposition 提取文件名（兜底用传入名） */
function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename="?([^";]+)"?/)
  return m ? m[1] : fallback
}

export class DownloadError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code = 'error') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 单图下载：GET Worker → 跟随 302 → blob → 另存。guest 得 401。 */
export async function downloadSingleImage(imageId: string, fallbackName: string): Promise<void> {
  const jwt = await getJwt()
  if (!jwt) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')

  const res = await fetch(`/api/downloads/image/${imageId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (res.status === 401) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
    if (body?.error?.code === 'account_disabled') {
      throw new DownloadError(t('download.accountDisabled'), 403, 'account_disabled')
    }
    throw new DownloadError(t('download.forbidden'), 403, 'forbidden')
  }
  if (res.status === 404) throw new DownloadError(t('download.imageUnavailable'), 404, 'not_found')
  if (!res.ok) throw new DownloadError(t('download.downloadFailed'), res.status, 'error')

  const blob = await res.blob()
  saveBlob(blob, filenameFromResponse(res, fallbackName))
}

/** 多选 ZIP：POST Worker {assetLanguageId, imageIds} → zip blob → 另存。 */
export async function downloadZip(
  assetLanguageId: string,
  imageIds: string[],
  fallbackName: string,
): Promise<void> {
  const jwt = await getJwt()
  if (!jwt) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')

  const res = await fetch('/api/downloads/zip', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetLanguageId, imageIds }),
  })
  if (res.status === 401) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
    if (body?.error?.code === 'account_disabled') {
      throw new DownloadError(t('download.accountDisabled'), 403, 'account_disabled')
    }
    throw new DownloadError(t('download.forbidden'), 403, 'forbidden')
  }
  if (res.status === 404) throw new DownloadError(t('download.langUnavailable'), 404, 'not_found')
  if (res.status === 413) {
    const body = await res.json().catch(() => null)
    throw new DownloadError(
      body?.error?.message ?? t('download.zipLimitExceeded'),
      413,
      'zip_limit_exceeded',
    )
  }
  if (!res.ok) throw new DownloadError(t('download.zipFailed'), res.status, 'error')

  const blob = await res.blob()
  saveBlob(blob, filenameFromResponse(res, fallbackName))
}

export interface DownloadSourceRow {
  id: string
  provider: 'quark' | 'baidu'
  url: string
}

/** Package 数据源：RLS 直连（登录 + enabled + asset published；guest 返回 0 行）。 */
export async function fetchDownloadSources(assetId: string): Promise<DownloadSourceRow[]> {
  const { data, error } = await supabase
    .from('download_sources')
    .select('id, provider, url')
    .eq('asset_id', assetId)
    .eq('enabled', true)
  if (error) throw new Error(error.message)
  return (data ?? []) as DownloadSourceRow[]
}
