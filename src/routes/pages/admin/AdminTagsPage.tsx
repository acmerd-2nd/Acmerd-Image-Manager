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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/spinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/** Admin 标签管理：Create / Rename（slug 不变）/ Delete（级联清关联，显示影响数） */
export function AdminTagsPage() {
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

  if (!isAdmin) return <p className="text-sm text-destructive">Admin only.</p>

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
      if (!name) throw new Error('标签名不能为空')
      await createTag(name)
      setNewName('')
    })

  const onRename = (id: string) =>
    run(async () => {
      const name = editName.trim()
      if (!name) throw new Error('标签名不能为空')
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
      <h1 className="text-xl font-semibold">Tags</h1>

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
          placeholder="New tag name"
          onKeyDown={(e) => e.key === 'Enter' && !busy && onCreate()}
        />
        <Button size="sm" disabled={busy || !newName.trim()} onClick={onCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Create
        </Button>
      </div>

      {tags === null ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : tags.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            还没有标签。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {tags.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex items-center gap-3 p-3">
                {editingId === t.id ? (
                  <>
                    <Input
                      className="max-w-xs"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <Button size="sm" disabled={busy} onClick={() => onRename(t.id)}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{t.name}</div>
                      <div className="truncate text-xs text-muted-foreground">/{t.slug}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(t.id)
                        setEditName(t.name)
                      }}
                    >
                      Rename
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => askDelete(t)}>
                      Delete
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
        title={`删除标签「${confirmDelete?.tag.name ?? ''}」？`}
        destructive
        confirmLabel="Delete"
        description={`该标签当前关联 ${confirmDelete?.count ?? 0} 个资产。删除将同时移除这些关联（资产本身不受影响）。`}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={onDelete}
      />
    </div>
  )
}
