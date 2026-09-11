import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * V1.7.2 苹果风主题开关（右上角）：`☀ [⬤──] 🌙`。
 * 视觉完全复用 LocaleSwitch 的轨道/白钮（h-[22px] w-[40px]、滑块 h-[18px] bg-white、
 * 开=bg-primary 关=bg-muted-foreground/40）；dark 为"开"态（滑块靠月亮一侧）。
 * 两侧 Sun/Moon 图标做激活态着色，替代语言开关的「中/EN」文字。
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  const { t } = useLocale()
  const isDark = theme === 'dark'

  return (
    <div
      className={cn('flex items-center gap-1.5 select-none', className)}
      role="group"
      aria-label={t('themeSwitch.label')}
    >
      <Sun className={cn('h-3.5 w-3.5 transition-colors', !isDark ? 'text-foreground' : 'text-muted-foreground')} />
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={t('themeSwitch.label')}
        onClick={toggleTheme}
        className={cn(
          'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
          isDark ? 'bg-primary' : 'bg-muted-foreground/40',
        )}
      >
        <span
          className={cn(
            'pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow ring-0 transition-transform',
            isDark ? 'translate-x-[20px]' : 'translate-x-[2px]',
          )}
        />
      </button>
      <Moon className={cn('h-3.5 w-3.5 transition-colors', isDark ? 'text-foreground' : 'text-muted-foreground')} />
    </div>
  )
}
