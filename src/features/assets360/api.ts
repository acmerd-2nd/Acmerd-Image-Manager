import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'
import type { Frame360Count, Published360Row, Sequence360Status } from '@/types/database'
import { FRAME_COUNTS_360 } from '@/types/database'
import type { Frame360Source } from '@/lib/image-source'

/**
 * V1.5 Phase B2：360° 序列数据访问层（Worker admin 端点客户端）。
 *
 * 不变量（沿用 V1.1/V1.4 冻结口径）：
 * - 浏览器只持有自己的 JWT；GITHUB_TOKEN / service_role 仅在 Worker Secret。
 * - 写路径一律经 Worker（原子状态机 + Worker 层审计），本模块不直连 360 表写入。
 * - 帧 URL 出口唯一：make360FrameUrl（见 @/lib/image-source），组件绝不自行拼 GitHub URL。
 * - 类型与 0022 CHECK 约束单一来源 = @/types/database（改库必须同步那里）。
 */

export const FRAME_COUNTS = FRAME_COUNTS_360
export type { Frame360Count, Sequence360Status }

/** 与 Worker 端 FRAME_BATCH_MAX 一致（Gate D3：≤24 帧 / ≤50MB 每请求） */
export const FRAME_BATCH_MAX = 24
/** 与 Worker 端 FRAME_MAX_SIZE 一致（单帧 5MB） */
export const FRAME_MAX_SIZE = 5 * 1024 * 1024
export const FRAME_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const

export interface Sequence360Summary {
  id: string
  frame_count: number
  status: Sequence360Status
  is_active: boolean
  uploaded_frames: number
}

export interface Sequence360List {
  sequences: Sequence360Summary[]
  active_sequence_id: string | null
}

export interface FrameProvision {
  frame_index: number
  source_path: string
}

export interface FrameUploadResult {
  uploaded: Array<{ frame_index: number; blob_sha: string }>
  failed: Array<{ frame_index: number; error: string }>
}

export class Seq360ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code = 'error') {
    super(message)
    this.name = 'Seq360ApiError'
    this.status = status
    this.code = code
  }
}

/** 已知错误码 → 本地化提示（未知码回落服务端文案） */
function toUserMessage(code: string, serverMsg: string | null, status: number): string {
  switch (code) {
    case 'frames_incomplete':
      return t('admin.s360.errFramesIncomplete')
    case 'sequence_is_active':
      return t('admin.s360.errSequenceActive')
    case 'invalid_state':
      return t('admin.s360.errInvalidState')
    case 'lease_busy':
      return t('admin.s360.errLeaseBusy')
    case 'retry_later':
      return t('admin.s360.errRetryLater')
    case 'not_found':
      return t('admin.s360.errNotFound')
    case 'bad_request':
      return t('admin.api.badRequest')
    case 'unauthorized':
      return t('admin.api.unauthorized')
    default:
      return serverMsg?.trim() ? serverMsg : t('admin.api.requestFailed', { status })
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Seq360ApiError(t('admin.api.unauthorized'), 401, 'unauthorized')

  const res = await fetch(path, { ...init, headers: { Authorization: `Bearer ${jwt}`, ...(init.headers ?? {}) } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const code = body?.error?.code ?? 'error'
    throw new Seq360ApiError(toUserMessage(code, body?.error?.message ?? null, res.status), res.status, code)
  }
  return (await res.json()) as T
}

/** [2] 序列清单（admin 全状态） */
export function listSequences(assetId: string): Promise<Sequence360List> {
  return request<Sequence360List>(`/api/admin/assets/${assetId}/360-sequences`)
}

/** [1] 创建序列（draft + 服务端预生成 frame_count 条帧行） */
export async function createSequence(
  assetId: string,
  frameCount: Frame360Count,
): Promise<{ sequenceId: string; frames: FrameProvision[] }> {
  if (!FRAME_COUNTS.includes(frameCount)) {
    throw new Seq360ApiError(t('admin.s360.errInvalidFrameCount'), 400, 'bad_request')
  }
  const r = await request<{ ok: boolean; sequence_id: string; frames: FrameProvision[] }>(
    `/api/admin/assets/${assetId}/360-sequences`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frame_count: frameCount }) },
  )
  return { sequenceId: r.sequence_id, frames: r.frames }
}

export interface FramePart {
  frame_index: number
  file: File
}

/**
 * [3] 分批传帧：自动按 FRAME_BATCH_MAX 切批、逐批上报进度。
 * 单帧网络抖动（GitHub 偶发 connection lost）→ 只重发失败帧，最多 3 轮尝试；
 * 仍失败的帧回传 failed[] 交调用方（后台提供「重试缺失帧」续传入口）。
 */
export async function uploadFrames(
  sequenceId: string,
  parts: FramePart[],
  onProgress?: (done: number, total: number, batchIndex: number) => void,
): Promise<FrameUploadResult> {
  const byIndex = new Map<number, File>(parts.map((p) => [p.frame_index, p.file]))
  const uploadedMap = new Map<number, string>()
  const lastError = new Map<number, string>()
  const total = parts.length
  let attempted = 0
  let batchNo = 0
  let pending = [...byIndex.keys()]

  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
    const retryNext: number[] = []
    for (let i = 0; i < pending.length; i += FRAME_BATCH_MAX) {
      const idxBatch = pending.slice(i, i + FRAME_BATCH_MAX)
      const form = new FormData()
      for (const idx of idxBatch) form.append(`f_${idx}`, byIndex.get(idx) as File, `${String(idx).padStart(4, '0')}.png`)
      const r = await request<{ ok: boolean; uploaded: FrameUploadResult['uploaded']; failed: FrameUploadResult['failed'] }>(
        `/api/admin/360-sequences/${sequenceId}/frames`,
        { method: 'POST', body: form },
      )
      batchNo += 1
      attempted += idxBatch.length
      for (const u of r.uploaded) {
        uploadedMap.set(u.frame_index, u.blob_sha)
        lastError.delete(u.frame_index)
      }
      for (const f of r.failed) {
        lastError.set(f.frame_index, f.error)
        if (attempt < 2) retryNext.push(f.frame_index)
      }
      onProgress?.(Math.min(attempted, total), total, batchNo)
    }
    pending = retryNext
  }

  return {
    uploaded: [...uploadedMap].map(([frame_index, blob_sha]) => ({ frame_index, blob_sha })),
    failed: [...lastError].map(([frame_index, error]) => ({ frame_index, error })),
  }
}

/** [4] complete（帧齐全 → 单 commit → ready；幂等） */
export async function completeSequence(
  sequenceId: string,
): Promise<{ already: boolean; commitSha: string | null }> {
  const r = await request<{ ok: boolean; already: boolean; commit_sha: string | null }>(
    `/api/admin/360-sequences/${sequenceId}/complete`,
    { method: 'POST' },
  )
  return { already: r.already, commitSha: r.commit_sha }
}

/** [5] 激活（原子切换 assets.active_360_sequence_id；DB 守卫触发器终审） */
export function activateSequence(sequenceId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/admin/360-sequences/${sequenceId}/activate`, { method: 'POST' })
}

/** [6] 删除序列（active 序列不可直删 → 服务端 409 sequence_is_active） */
export function deleteSequence(sequenceId: string): Promise<{ ok: boolean; removed_remote_files: number }> {
  return request<{ ok: boolean; removed_remote_files: number }>(`/api/admin/360-sequences/${sequenceId}`, { method: 'DELETE' })
}

/** [7] 移除当前启用的 360（先下线指针 → 清远端 → 删行；前台即时消失） */
export function removeActive360(assetId: string): Promise<{ ok: boolean; removed: boolean }> {
  return request<{ ok: boolean; removed: boolean }>(`/api/admin/assets/${assetId}/360`, { method: 'DELETE' })
}

/**
 * 后台 Preview 用：admin 经 RLS 直读该序列已 ready 的帧路径（按 frame_index 升序）。
 * 只读直连属既有口径（同 audit_logs 的 D4 读取面）；写路径仍全部走 Worker。
 */
export async function listSequenceFrameSources(sequenceId: string): Promise<Frame360Source[]> {
  const { data, error } = await supabase
    .from('asset_360_frames')
    .select('frame_index, source_path')
    .eq('sequence_id', sequenceId)
    .eq('status', 'ready')
    .order('frame_index', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? [])
    .filter((r: { source_path: string | null }) => !!r.source_path)
    .map((r: { frame_index: number; source_path: string }) => ({ index: r.frame_index, path: r.source_path }))
}

/**
 * 「补传缺失帧」用：admin 经 RLS 直读该序列尚未登记 blob 的帧序号（升序）。
 * 存在理由：页面刷新后草稿态丢失，若没有这个入口，一条 35/36 的上传中序列只能整条重传。
 */
export async function listMissingFrameIndices(sequenceId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from('asset_360_frames')
    .select('frame_index')
    .eq('sequence_id', sequenceId)
    .is('blob_sha', null)
    .order('frame_index', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: { frame_index: number }) => r.frame_index)
}

/** 前台 Viewer 唯一数据源：published 资产 + active ready 序列（无 360 → null，页面零渲染） */
export async function getPublished360(assetId: string): Promise<Published360Row | null> {
  const { data, error } = await supabase
    .from('published_360')
    .select('*')
    .eq('asset_id', assetId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Published360Row) ?? null
}
