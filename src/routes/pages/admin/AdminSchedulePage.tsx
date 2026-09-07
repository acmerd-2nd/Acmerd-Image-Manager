import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { ScheduleItemRow } from '@/types/database'
import {
  createScheduleItem,
  deleteScheduleItem,
  listScheduleItems,
  updateScheduleItem,
} from '@/features/schedule/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/**
 * V1.2-B D8：Schedule 内容编排页（Admin）。
 * 列表（event_date asc nulls last + sort_order，Worker 已排序）+ 创建/内联编辑/删除/上下移。
 * 写走 Worker admin 端点（原子 + 审计 schedule.item_*）；发布前无 cover 等前置门槛（D6 字段最小集）。
 */
export function AdminSchedulePage() {
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const [items, setItems] = useState<ScheduleItemRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 新建表单
  const [newTitle, setNewTitle] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newDesc, setNewDesc] = useState('')

  // 内联编辑
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editDesc, setEditDesc] = useState('')

  const [confirmDelete, setConfirmDelete] = useState<ScheduleItemRow | null>(null)

  const reload = useCallback(async () => {
    try {
      const { items: rows } = await listScheduleItems()
      setItems(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const onCreate = () =>
    run(async () => {
      const title = newTitle.trim()
      if (!title) throw new Error(t('admin.schedule.titleRequired'))
      await createScheduleItem({
        title,
        description: newDesc.trim() || null,
        eventDate: newDate || null,
      })
      setNewTitle('')
      setNewDate('')
      setNewDesc('')
    })

  const beginEdit = (item: ScheduleItemRow) => {
    setEditingId(item.id)
    setEditTitle(item.title)
    setEditDate(item.event_date ?? '')
    setEditDesc(item.description ?? '')
  }

  const onSaveEdit = (item: ScheduleItemRow) =>
    run(async () => {
      const title = editTitle.trim()
      if (!title) throw new Error(t('admin.schedule.titleRequired'))
      await updateScheduleItem(item.id, {
        title,
        description: editDesc.trim() || null,
        eventDate: editDate || null,
      })
      setEditingId(null)
    })

  const onTransition = (item: ScheduleItemRow, to: 'draft' | 'published' | 'archived') =>
    run(async () => {
      await updateScheduleItem(item.id, { status: to })
    })

  // 上下移：相邻两条交换 sort_order（两次原子 PATCH，V1 惯例；仅对同组「均有日期/均无日期」生效——
  // 简化：直接对相邻条目交换，视图排序为 event_date,sort_order，日期不同时交换 sort_order 不改变相对序，
  // 故上下移只在同日期条目间有意义；跨日期由日期本身控制）
  const onMove = (item: ScheduleItemRow, dir: -1 | 1) => {
    if (!items) return
    const idx = items.findIndex((x) => x.id === item.id)
    const neighbor = items[idx + dir]
    if (!neighbor) return
    if (neighbor.event_date !== item.event_date) return // 日期不同：排序由日期决定，交换无意义
    run(async () => {
      await updateScheduleItem(item.id, { sortOrder: neighbor.sort_order })
      await updateScheduleItem(neighbor.id, { sortOrder: item.sort_order })
    })
  }

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('admin.page.schedule')}</h1>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 新建 */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex max-w-2xl flex-wrap gap-2">
            <Input
              className="min-w-48 flex-1"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t('admin.schedule.newTitle')}
            />
            <Input
              className="w-40"
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
            />
            <Button size="sm" disabled={busy || !newTitle.trim()} onClick={onCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t('admin.schedule.create')}
            </Button>
          </div>
          <Input
            className="max-w-2xl"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={t('admin.schedule.description')}
          />
          <p className="text-xs text-muted-foreground">{t('admin.schedule.hint')}</p>
        </CardContent>
      </Card>

      {items === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('admin.schedule.empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item, idx) => {
            const prev = items[idx - 1]
            const next = items[idx + 1]
            const canUp = !!prev && prev.event_date === item.event_date && prev.sort_order !== item.sort_order
            const canDown = !!next && next.event_date === item.event_date && next.sort_order !== item.sort_order
            return (
              <Card key={item.id}>
                <CardContent className="space-y-3 p-3">
                  {editingId === item.id ? (
                    <div className="space-y-2">
                      <div className="flex max-w-2xl flex-wrap gap-2">
                        <Input
                          className="min-w-48 flex-1"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                        />
                        <Input
                          className="w-40"
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                        <Button size="sm" disabled={busy} onClick={() => onSaveEdit(item)}>
                          {t('common.save')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                      <Input
                        className="max-w-2xl"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder={t('admin.schedule.description')}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{item.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {item.event_date ?? t('admin.schedule.noDate')}
                          {item.description ? ` · ${item.description}` : ''}
                        </div>
                      </div>
                      <Badge
                        variant={
                          item.status === 'published'
                            ? 'default'
                            : item.status === 'draft'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {item.status === 'published'
                          ? t('admin.status.published')
                          : item.status === 'draft'
                            ? t('admin.status.draft')
                            : t('admin.status.archived')}
                      </Badge>
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="outline" disabled={busy || !canUp} onClick={() => onMove(item, -1)}>
                          ↑
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy || !canDown} onClick={() => onMove(item, 1)}>
                          ↓
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => beginEdit(item)}>
                          {t('admin.action.edit')}
                        </Button>
                        {item.status !== 'published' && (
                          <Button size="sm" disabled={busy} onClick={() => onTransition(item, 'published')}>
                            {t('admin.action.publish')}
                          </Button>
                        )}
                        {item.status === 'published' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(item, 'draft')}>
                            {t('admin.action.unpublish')}
                          </Button>
                        )}
                        {item.status !== 'archived' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(item, 'archived')}>
                            {t('admin.action.archive')}
                          </Button>
                        )}
                        {item.status === 'archived' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(item, 'draft')}>
                            {t('admin.action.restore')}
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(item)}>
                          {t('admin.action.delete')}
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('admin.schedule.deleteTitle', { name: confirmDelete?.title ?? '' })}
        destructive
        confirmLabel={t('admin.action.delete')}
        description={t('admin.schedule.deleteBody')}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() =>
          confirmDelete &&
          run(async () => {
            await deleteScheduleItem(confirmDelete.id)
            setConfirmDelete(null)
          })
        }
      />
    </div>
  )
}
