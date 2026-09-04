import { zh, type Dictionary } from './zh'
import { en } from './en'

export type UiLocale = 'zh-CN' | 'en'

/**
 * V1.1 D2 冻结规则：uiLocale ≠ assetLanguage。
 * uiLocale 只控制界面文案；Asset 语言（en/de/it/fr/es）是内容维度，二者完全隔离。
 */

const DICTIONARIES: Record<UiLocale, Dictionary> = {
  'zh-CN': zh,
  en,
}

const STORAGE_KEY = 'uiLocale'

export function getUiLocale(): UiLocale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'zh-CN' || v === 'en') return v
  } catch {
    /* SSR/隐私模式降级 */
  }
  return 'zh-CN'
}

export function setUiLocale(locale: UiLocale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* 降级：仅本次会话生效 */
  }
}

export type TKey = keyof Dictionary | (string & {})

/** 极简 t()：点号路径查 key，缺失时回落 zh-CN，再缺失返回 key 本身 */
export function t(key: TKey): string {
  const locale = getUiLocale()
  const dicts = [DICTIONARIES[locale], zh]
  for (const dict of dicts) {
    const resolved = key.split('.').reduce<unknown>((node, seg) => {
      if (node && typeof node === 'object' && seg in (node as Record<string, unknown>)) {
        return (node as Record<string, unknown>)[seg]
      }
      return undefined
    }, dict)
    if (typeof resolved === 'string') return resolved
  }
  return key
}

export { zh, en }
export type { Dictionary }
