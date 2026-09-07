import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import type { PublishedScheduleItemRow } from '@/types/database'
import { listPublishedScheduleItems } from '@/features/schedule/api'
import { useLocale } from '@/i18n'

/**
 * V1.1 PC-3 + V1.2-B D7：排期页。
 * 有内容 → 按 event_date asc nulls last, sort_order asc 渲染真实条目（视图已排序）；
 * 空态 → Coming Soon（总纲 §23 既有产品态）。
 * 导航显隐由 site_settings.schedule_navigation_enabled 控制（AppShell）；本页始终可直达。
 */
export function SchedulePage() {
  const { t } = useLocale()
  const [items, setItems] = useState<PublishedScheduleItemRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listPublishedScheduleItems()
      .then((rows) => !cancelled && setItems(rows))
      .catch(() => !cancelled && setItems([]))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">{t('schedule.title')}</h1>

      {items === null ? (
        <div className="mt-10 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-24 text-center">
          <CalendarClock className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-6 text-lg font-medium">{t('schedule.comingSoon')}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('schedule.comingSoonHint')}</p>
        </div>
      ) : (
        <div className="mt-8 space-y-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">{item.title}</h2>
                {item.event_date && (
                  <time className="text-sm text-muted-foreground" dateTime={item.event_date}>
                    {item.event_date}
                  </time>
                )}
              </div>
              {item.description && (
                <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{item.description}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
