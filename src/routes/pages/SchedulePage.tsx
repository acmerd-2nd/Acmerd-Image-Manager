import { CalendarClock } from 'lucide-react'
import { useLocale } from '@/i18n'

/**
 * V1.1 PC-3：排期页（Coming Soon 产品态）。
 * 总纲 §23：排期页面即使没有内容也显示 Coming Soon；导航显隐由
 * site_settings.schedule_navigation_enabled 控制（AppShell）；本页始终可直达（非 403/404）。
 * 未来 schedule.items 内容编排不在 V1.1 范围（Gate §113）。
 */
export function SchedulePage() {
  const { t } = useLocale()
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-24 text-center sm:px-6">
      <CalendarClock className="mx-auto h-12 w-12 text-muted-foreground/50" />
      <h1 className="mt-6 text-3xl font-bold tracking-tight">{t('schedule.title')}</h1>
      <p className="mt-3 text-lg font-medium">{t('schedule.comingSoon')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('schedule.comingSoonHint')}</p>
    </div>
  )
}
