/**
 * 苹果风格 Switch 开关（V1 自维护，零依赖，无 radix）。
 * V1.3.1 跟进：Unlimited 积分开关等场景；开启=绿（Apple 语义）。
 */
export function Switch({
  checked,
  disabled = false,
  onCheckedChange,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        checked ? 'bg-green-500' : 'bg-muted-foreground/30'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span
        className={`pointer-events-none ml-0.5 inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
