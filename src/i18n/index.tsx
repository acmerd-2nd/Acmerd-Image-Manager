import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { zh, type Dictionary } from './zh'
import { en } from './en'

export type UiLocale = 'zh-CN' | 'en'

/**
 * V1.1 PC-1 冻结规则：uiLocale ≠ assetLanguage。
 * uiLocale 只控制界面文案（本文件）；Asset 语言（en/de/it/fr/es）是内容维度（?lang=），二者完全隔离。
 */

/** Owner 指定的 localStorage key（总纲 §5） */
const STORAGE_KEY = 'acmerd.ui.locale'

const DICTIONARIES: Record<UiLocale, Dictionary> = {
  'zh-CN': zh,
  en,
}

export function getUiLocale(): UiLocale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'zh-CN' || v === 'en') return v
  } catch {
    /* 隐私模式降级 */
  }
  return 'zh-CN'
}

export function setUiLocalePersisted(locale: UiLocale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* 降级：仅本次会话生效 */
  }
}

export type TKey = keyof Dictionary | (string & {})
export type TParams = Record<string, string | number>

/** 插值：{name} → params.name */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}

/** 点号路径查 key：当前语言缺失回落 zh-CN，再缺失返回 key 本身 */
function resolve(locale: UiLocale, key: TKey, params?: TParams): string {
  const dicts = [DICTIONARIES[locale], zh]
  for (const dict of dicts) {
    const resolved = key.split('.').reduce<unknown>((node, seg) => {
      if (node && typeof node === 'object' && seg in (node as Record<string, unknown>)) {
        return (node as Record<string, unknown>)[seg]
      }
      return undefined
    }, dict)
    if (typeof resolved === 'string') return interpolate(resolved, params)
  }
  return key
}

/** 非 React 场景的 t()（读 localStorage 当前值） */
export function t(key: TKey, params?: TParams): string {
  return resolve(getUiLocale(), key, params)
}

export { zh, en }
export type { Dictionary }

// ===========================================================================
// React 绑定（PC-1）：Provider 持有 locale state，切换即时重渲染、不刷新页面
// ===========================================================================
interface LocaleContextValue {
  locale: UiLocale
  setLocale: (locale: UiLocale) => void
  t: (key: TKey, params?: TParams) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(() => getUiLocale())

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next)
    setUiLocalePersisted(next)
    // 同步 <html lang>，利于无障碍与字体渲染
    try {
      document.documentElement.lang = next
    } catch {}
  }, [])

  const tBound = useCallback(
    (key: TKey, params?: TParams) => resolve(locale, key, params),
    [locale],
  )

  const value = useMemo(() => ({ locale, setLocale, t: tBound }), [locale, setLocale, tBound])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

/** 组件内使用：const { t, locale, setLocale } = useLocale() */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    // 兜底（理论上 main.tsx 已包 Provider）：退化为 localStorage 读取
    return { locale: getUiLocale(), setLocale: setUiLocalePersisted, t }
  }
  return ctx
}
