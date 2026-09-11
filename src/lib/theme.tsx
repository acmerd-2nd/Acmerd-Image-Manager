import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * V1.7.2 主题（暗黑模式）Provider。
 *
 * 地基早已就绪：tailwind `darkMode:'class'` + colors 全走 CSS 变量 + `src/index.css` 的 `.dark` 变量块。
 * 本模块只做"接线"：读写 localStorage（命名空间 acmerd.ui.*，与 i18n 同范式）、
 * toggle `document.documentElement` 的 `dark` 类。默认浅色（Owner 决策）；首帧防闪烁另见 index.html 内联脚本。
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'acmerd.ui.theme'

function getInitialTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    /* 隐私模式 / localStorage 不可用 → 回落默认浅色 */
  }
  return 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* 忽略持久化失败（隐私模式） */
    }
  }, [theme])

  const setTheme = useCallback((t: Theme) => setThemeState(t), [])
  const toggleTheme = useCallback(() => setThemeState((v) => (v === 'dark' ? 'light' : 'dark')), [])

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
}

/** 未挂 Provider 时返回只读浅色兜底，绝不抛错（与 LocaleContext 兜底风格一致）。 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx) return ctx
  return { theme: 'light', setTheme: () => {}, toggleTheme: () => {} }
}
