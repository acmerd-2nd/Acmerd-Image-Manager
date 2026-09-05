import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { TagRow } from '@/types/database'
import {
  countAssetsForTag,
  createTag,
  deleteTag,
  listTags,
  renameTag,
} from '@/features/tags/api'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/** Admin 标签管理：Create / Rename（slug 不变）/ Delete（级联清关联，显示影响数） */
export function AdminTagsPage() {
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const [tags, setTags] = useState<TagRow[] | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<{ tag: TagRow; count: number } | null>(null)

  const reload = useCallback(async () => {
    try {
      setTags(await listTags())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  if (!isAdmin) return <p className="text-sm text-destructive">{t('admin.adminOnly')}</p>

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
      const name = newName.trim()
      if (!name) throw new Error(t('admin.tags.nameRequired'))
      await createTag(name)
      setNewName('')
    })

  const onRename = (id: string) =>
    run(async () => {
      const name = editName.trim()
      if (!name) throw new Error(t('admin.tags.nameRequired'))
      await renameTag(id, name)
      setEditingId(null)
    })

  const askDelete = async (tag: TagRow) => {
    const count = await countAssetsForTag(tag.id).catch(() => 0)
    setConfirmDelete({ tag, count })
  }

  const onDelete = () =>
    run(async () => {
      if (!confirmDelete) return
      await deleteTag(confirmDelete.tag.id)
      setConfirmDelete(null)
    })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('admin.page.tags')}</h1>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 新建 */}
      <div className="flex max-w-md gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('admin.tags.newName')}
          onKeyDown={(e) => e.key === 'Enter' && !busy && onCreate()}
        />
        <Button size="sm" disabled={busy || !newName.trim()} onClick={onCreate}>
          <Plus className="mr-1 h-4 w-4" />
          {t('admin.action.create')}
        </Button>
      </div>

      {tags === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : tags.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('admin.noTags')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {tags.map((tag) => (
            <Card key={tag.id}>
              <CardContent className="flex items-center gap-3 p-3">
                {editingId === tag.id ? (
                  <>
                    <Input
                      className="max-w-xs"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <Button size="sm" disabled={busy} onClick={() => onRename(tag.id)}>
                      {t('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{tag.name}</div>
                      <div className="truncate text-xs text-muted-foreground">/{tag.slug}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(tag.id)
                        setEditName(tag.name)
                      }}
                    >
                      {t('admin.action.rename')}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => askDelete(tag)}>
                      {t('admin.action.delete')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('admin.tags.deleteTitle', { name: confirmDelete?.tag.name ?? '' })}
        destructive
        confirmLabel={t('admin.action.delete')}
        description={confirmDelete ? t('admin.tags.deleteBody', { n: confirmDelete.count }) : ''}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={onDelete}
      />
    </div>
  )
}
