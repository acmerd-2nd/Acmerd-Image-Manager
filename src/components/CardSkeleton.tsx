import { cn } from '@/lib/utils'

/**
 * 卡片骨架（Phase 9 D8）：尺寸与真实 AssetCard 对齐（4:3 图区 + 文本区），
 * 避免加载期布局抖动（CLS）。图片区比例与 D4 缩略一致。
 */
export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="aspect-[4/3] w-full animate-pulse bg-muted" />
      <div className="space-y-2 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

/** 网格骨架：渲染 count 个 CardSkeleton，占位与真实网格同构 */
export function CardGridSkeleton({ count = 8, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}
