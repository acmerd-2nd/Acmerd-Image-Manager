import { useEffect, useRef, type MutableRefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * V1.9.0 P1-4 通用对话框无障碍行为：打开时聚焦首个可交互元素、Tab 在面板内循环、
 * Esc 触发关闭、卸载后把焦点还原给打开前的元素。纯 hook（不引 radix Dialog）。
 *
 * 用法：const ref = useFocusTrap(open, onCancel); 把 ref 挂到对话框面板元素上。
 * active=false 时不启用（配合组件在 !open 时提前 return null 也可，安全）。
 */
export function useFocusTrap<T extends HTMLElement>(active = true, onClose?: () => void): MutableRefObject<T | null> {
  const panelRef = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!active) return
    const panel = panelRef.current
    if (!panel) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const getFocusable = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)

    // 初次聚焦：优先第一个可交互元素，否则面板自身
    const initial = getFocusable()[0]
    ;(initial ?? panel).focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = getFocusable()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const cur = document.activeElement as HTMLElement | null
      if (e.shiftKey && (cur === first || !panel.contains(cur))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.({ preventScroll: true })
    }
  }, [active])

  return panelRef
}
