import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * 苹果风中英切换（Phase C PC-1，总纲 §4）：
 * `中 [⬤──] EN`，置于左上角。只负责界面语言（uiLocale），
 * 与 Asset Language（?lang=）完全隔离；切换即时生效、不刷新页面。
 */
export function LocaleSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale()
  const isZh = locale === 'zh-CN'

  return (
    <div
      className={cn('flex items-center gap-1.5 select-none', className)}
      role="group"
      aria-label={t('localeSwitch.label')}
    >
      <span
        className={cn(
          'text-xs font-medium transition-colors',
          isZh ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {t('localeSwitch.zh')}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!isZh}
        aria-label={t('localeSwitch.label')}
        onClick={() => setLocale(isZh ? 'en' : 'zh-CN')}
        className={cn(
          'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
          isZh ? 'bg-primary' : 'bg-muted-foreground/40',
        )}
      >
        <span
          className={cn(
            'pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow ring-0 transition-transform',
            isZh ? 'translate-x-[20px]' : 'translate-x-[2px]',
          )}
        />
      </button>
      <span
        className={cn(
          'text-xs font-medium transition-colors',
          !isZh ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {t('localeSwitch.en')}
      </span>
    </div>
  )
}
