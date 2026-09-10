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
  /** 402 insufficient_credits 时附带（余额预判与提示用） */
  detail?: { required?: number; balance?: number | null }
  constructor(message: string, status: number, code = 'error', detail?: { required?: number; balance?: number | null }) {
    super(message)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** Q2 裁决：每次点击生成 uuid，经 X-Idempotency-Key 透传 RPC（H2 幂等协议） */
function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** 单图下载：GET Worker → 跟随 302 → blob → 另存。guest 得 401。 */
export async function downloadSingleImage(imageId: string, fallbackName: string): Promise<void> {
  const jwt = await getJwt()
  if (!jwt) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')

  const res = await fetch(`/api/downloads/image/${imageId}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Idempotency-Key': newIdempotencyKey() },
  })
  if (res.status === 401) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  if (res.status === 402) {
    const body = (await res.json().catch(() => null)) as { error?: { required?: number; balance?: number } } | null
    throw new DownloadError(t('credits.insufficient'), 402, 'insufficient_credits', {
      required: body?.error?.required,
      balance: body?.error?.balance,
    })
  }
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
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': newIdempotencyKey(),
    },
    body: JSON.stringify({ assetLanguageId, imageIds }),
  })
  if (res.status === 401) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  if (res.status === 402) {
    const body = (await res.json().catch(() => null)) as { error?: { required?: number; balance?: number } } | null
    throw new DownloadError(t('credits.insufficient'), 402, 'insufficient_credits', {
      required: body?.error?.required,
      balance: body?.error?.balance,
    })
  }
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

/** PC-4：当前用户积分余额（credit_accounts RLS select own；null = unlimited） */
export async function fetchMyCredits(): Promise<{ balance: number; unlimited: boolean } | null> {
  const { data, error } = await supabase
    .from('credit_accounts')
    .select('balance, unlimited')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return { balance: Number(data.balance), unlimited: data.unlimited === true }
}

/** PC-4：Package 跳转前经 Worker 原子扣分；返回 url 供 window.open（跳转即消耗，不退款） */
export async function authorizePackageDownload(sourceId: string): Promise<{ url: string; provider: string }> {
  const jwt = await getJwt()
  if (!jwt) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  const res = await fetch('/api/downloads/package', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': newIdempotencyKey(),
    },
    body: JSON.stringify({ sourceId }),
  })
  if (res.status === 401) throw new DownloadError(t('download.needLogin'), 401, 'unauthorized')
  if (res.status === 402) {
    const body = (await res.json().catch(() => null)) as { error?: { required?: number; balance?: number } } | null
    throw new DownloadError(t('credits.insufficient'), 402, 'insufficient_credits', {
      required: body?.error?.required,
      balance: body?.error?.balance,
    })
  }
  if (res.status === 404) throw new DownloadError(t('download.imageUnavailable'), 404, 'not_found')
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (body?.error?.code === 'idempotency_conflict') {
      throw new DownloadError(body.error.message ?? 'Conflict', 409, 'idempotency_conflict')
    }
    throw new DownloadError(t('download.downloadFailed'), res.status, 'error')
  }
  const payload = (await res.json()) as { ok: boolean; url: string; provider: string }
  return { url: payload.url, provider: payload.provider }
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

// ============================================================================
// V1.6.0-A：后台「网盘链接」写入层
// 读链路（fetchDownloadSources + Worker 扣分跳转）早已就绪，缺的只是 admin 写入入口。
// download_sources 的 admin insert/update/delete RLS 策略、URL 安全触发器（0004）、
// download_source.updated 审计（0001）均已存在，故这里直连 Supabase、零迁移零 Worker 改动。
// ============================================================================

export type DownloadProvider = 'quark' | 'baidu'

export interface DownloadSourceAdminRow {
  id: string
  provider: DownloadProvider
  url: string
  enabled: boolean
}

/** URL 不合法（DB 0004 触发器终审 / 前端二次防御）时抛出的可本地化错误。 */
export class DownloadSourceError extends Error {
  code: 'invalid_url' | 'error'
  constructor(code: 'invalid_url' | 'error', message: string) {
    super(message)
    this.code = code
  }
}

/** 某资产全部网盘源（含未启用，admin 视角；RLS is_admin 放行）。 */
export async function listDownloadSourcesAdmin(assetId: string): Promise<DownloadSourceAdminRow[]> {
  const { data, error } = await supabase
    .from('download_sources')
    .select('id, provider, url, enabled')
    .eq('asset_id', assetId)
    .order('provider')
  if (error) throw new DownloadSourceError('error', error.message)
  return (data ?? []) as DownloadSourceAdminRow[]
}

/** 按 (asset_id, provider) upsert；URL 合法性由 0004 触发器终审，失败映射为 invalid_url。 */
export async function saveDownloadSource(input: {
  assetId: string
  provider: DownloadProvider
  url: string
  enabled: boolean
}): Promise<void> {
  const url = input.url.trim()
  const { error } = await supabase.from('download_sources').upsert(
    {
      asset_id: input.assetId,
      provider: input.provider,
      url,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'asset_id,provider' },
  )
  if (error) {
    if (error.message.includes('DOWNLOAD_URL_INVALID')) {
      throw new DownloadSourceError('invalid_url', error.message)
    }
    throw new DownloadSourceError('error', error.message)
  }
}

/** 物理删除某条网盘源（写 download_source.updated 审计）。 */
export async function deleteDownloadSource(id: string): Promise<void> {
  const { error } = await supabase.from('download_sources').delete().eq('id', id)
  if (error) throw new DownloadSourceError('error', error.message)
}
