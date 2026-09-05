import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 数字分页控件（Phase 9 D1）：复用 AdminUsers 语义，?page=N 由调用方同步到 URL。
 * 越界由调用方/RPC 兜底（空页正常返回），此处只做展示与翻页。
 */
export function Pagination({
  page,
  perPage,
  total,
  onPage,
  className,
}: {
  page: number
  perPage: number
  total: number
  onPage: (page: number) => void
  className?: string
}) {
  const { t } = useLocale()
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  if (total <= perPage) return null // 单页不显示分页条

  const go = (p: number) => onPage(Math.min(Math.max(p, 1), totalPages))

  return (
    <div className={cn('flex items-center justify-center gap-2 py-6', className)}>
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go(page - 1)}>
        <ChevronLeft className="h-4 w-4" />
        {t('pagination.prev')}
      </Button>
      <span className="px-2 text-sm text-muted-foreground">
        {t('pagination.pageOf', { page, total: totalPages, count: total })}
      </span>
      <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => go(page + 1)}>
        {t('pagination.next')}
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
