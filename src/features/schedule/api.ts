import { supabase } from '@/lib/supabase/client'
import { t } from '@/i18n'
import type { PublishedScheduleItemRow, ScheduleItemRow } from '@/types/database'

/**
 * V1.2-B D7/D8：Schedule 数据访问层（镜像 collections/api 范式）。
 * - 公开读：published_schedule_items 视图（security_invoker；仅 published，
 *   event_date asc nulls last + sort_order asc，视图内已排序）
 * - Admin 读：RLS is_admin 放行；写走 Worker admin 端点（原子 + 审计 schedule.item_*）
 */

export async function listPublishedScheduleItems(): Promise<PublishedScheduleItemRow[]> {
  const { data, error } = await supabase.from('published_schedule_items').select('*')
  if (error) throw new Error(error.message)
  return (data ?? []) as PublishedScheduleItemRow[]
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error(t('admin.api.unauthorized'))
  return { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
}

async function scheduleRequest<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const headers = await adminHeaders()
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: { code?: string; message?: string } }
    | null
  if (!res.ok || (payload && payload.ok === false)) {
    const err = new Error(
      payload?.error?.message ?? t('admin.api.requestFailed', { status: res.status }),
    ) as Error & { code?: string }
    err.code = payload?.error?.code
    throw err
  }
  return payload as T
}

/** Admin：全部状态条目（Worker 按 event_date asc nulls last + sort_order 排好序返回） */
export function listScheduleItems(): Promise<{ ok: true; items: ScheduleItemRow[] }> {
  return scheduleRequest('/api/admin/schedule-items')
}

export interface ScheduleItemInput {
  title: string
  description?: string | null
  /** YYYY-MM-DD 或 null（无日期条目沉底，视图 nulls last） */
  eventDate?: string | null
  sortOrder?: number
}

export function createScheduleItem(input: ScheduleItemInput) {
  return scheduleRequest<{ ok: true; item: ScheduleItemRow }>('/api/admin/schedule-items', input, 'POST')
}

export function updateScheduleItem(
  id: string,
  patch: Partial<ScheduleItemInput> & { status?: 'draft' | 'published' | 'archived' },
) {
  return scheduleRequest<{ ok: true; item: ScheduleItemRow }>(`/api/admin/schedule-items/${id}`, patch, 'PATCH')
}

export function deleteScheduleItem(id: string) {
  return scheduleRequest<{ ok: true }>(`/api/admin/schedule-items/${id}`, undefined, 'DELETE')
}
