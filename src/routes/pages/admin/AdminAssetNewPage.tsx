import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createAsset, slugify } from '@/features/assets/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 新建 Asset：Step 1 基础信息 → 建 draft → 进入编辑器继续上传/封面/发布 */
export function AdminAssetNewPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveSlug = (slugEdited ? slug : slugify(name)).toLowerCase()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('请填写 Name')
      return
    }
    if (!/^[a-z0-9\u4e00-\u9fff]+(-[a-z0-9\u4e00-\u9fff]+)*$/.test(effectiveSlug)) {
      setError('Slug 只能包含小写字母、数字、中文，用连字符分隔')
      return
    }

    setSubmitting(true)
    try {
      const asset = await createAsset({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
      })
      navigate(`/admin/assets/${asset.id}`, { replace: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg.includes('duplicate key') ? 'Slug 已被占用，请换一个' : msg)
    }
    setSubmitting(false)
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">New Asset</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="asset-name" className="text-sm font-medium">
            Name *
          </label>
          <Input
            id="asset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alpine Landscapes Vol.1"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="asset-slug" className="text-sm font-medium">
            Slug（URL 标识，自动生成可改）
          </label>
          <Input
            id="asset-slug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase())
              setSlugEdited(true)
            }}
            placeholder="auto from name"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="asset-desc" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="asset-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? '创建中…' : '创建草稿并继续'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/admin/assets')}>
            Cancel
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">
        创建后进入编辑器：上传图片 → 排序 → Set Cover → Publish（Publish 需至少 1 个含图的语言版本）。
      </p>
    </div>
  )
}
