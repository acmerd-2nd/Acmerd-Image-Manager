import { flushSync } from 'react-dom'

/**
 * V1.9.2 — 动效基座（纯 Web API，零第三方依赖）
 *
 * 两块能力：
 *  1) initMotion()：一次性装配「滚动/挂载入场揭示」引擎。给页面里带 [data-reveal] 的元素
 *     按「同一父容器内的兄弟顺序」注入 --reveal-index（stagger 延迟），并用一个共享
 *     IntersectionObserver 在进入视口时打上 [data-revealed]（CSS 负责淡入 + 位移）。
 *     - 仅当【浏览器支持 IO】且【系统未要求减少动效】时才给 <html> 加 .js-motion，
 *       从而 CSS 的隐藏态才会生效；否则内容默认可见，杜绝脚本失败/老浏览器导致的白屏。
 *     - MutationObserver 兜住后续动态新增（分页、搜索、拖拽后重排、异步水合）的节点。
 *  2) startViewNavigation()：把一次「程序化路由跳转」包进 document.startViewTransition，
 *     使 DOM 在过渡回调里同步更新（flushSync），触发 index.css 里 app-main 的软入淡出。
 *     - 不支持 / 减少动效 / 出错 → 一律回退为普通 navigate（行为零退化）。
 *
 * 声明式跳转（<Link>/<NavLink>）走 react-router 的 viewTransition 属性，不经此文件。
 */

type StartViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished?: Promise<void>; aborted?: Promise<void> }
}

/** 系统是否要求「减少动态效果」（无障碍）。SSR/异常下按「不减少」处理。 */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

let io: IntersectionObserver | null = null
let mo: MutationObserver | null = null

function sharedObserver(): IntersectionObserver {
  if (io) return io
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.setAttribute('data-revealed', '')
        io!.unobserve(entry.target)
      }
    },
    // 轻微提前于视口底部触发，配合 CSS delay 形成瀑布式入场
    { rootMargin: '0px 0px -6% 0px', threshold: 0.01 },
  )
  return io
}

/** 计算元素在【同一父容器内、同为 data-reveal 的直接子节点】中的序号，作为 stagger 下标 */
function assignRevealIndex(el: HTMLElement): void {
  const parent = el.parentElement
  if (!parent) return
  const sibs = parent.querySelectorAll<HTMLElement>(':scope > [data-reveal]')
  const idx = Array.prototype.indexOf.call(sibs, el)
  if (idx > 0) el.style.setProperty('--reveal-index', String(idx))
}

function registerEl(el: HTMLElement): void {
  if (el.hasAttribute('data-reveal-observed')) return
  el.setAttribute('data-reveal-observed', '')
  assignRevealIndex(el)
  sharedObserver().observe(el)
}

/** 扫描某子树内尚未揭示的 [data-reveal] 并登记（含子树，覆盖被整体插入的列表/网格） */
function scanAndRegister(root: Element): void {
  if (root.matches('[data-reveal]:not([data-revealed])')) registerEl(root as HTMLElement)
  root
    .querySelectorAll<HTMLElement>('[data-reveal]:not([data-revealed])')
    .forEach(registerEl)
}

/** 装配入场揭示引擎。应在应用挂载后调用一次（main.tsx）。 */
export function initMotion(): void {
  if (typeof document === 'undefined' || io || mo) return

  // 老浏览器 / 无 IO：不启用（内容天然可见，交给各自的 transition 兜底）
  if (typeof IntersectionObserver === 'undefined') return

  // 无障碍：直接标记全部已揭示，且不启用隐藏态（.js-motion 不添加）
  if (prefersReducedMotion()) {
    document
      .querySelectorAll<HTMLElement>('[data-reveal]')
      .forEach((el) => el.setAttribute('data-revealed', ''))
    return
  }

  document.documentElement.classList.add('js-motion')
  scanAndRegister(document.body)

  mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === 1) scanAndRegister(node as Element)
      })
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })
}

/**
 * 用 View Transition 包裹一次程序化跳转。回调里 flushSync 确保 DOM 同步变化，
 * 使 app-main 的 ::view-transition-new/old 动画生效。不支持/减少动效/异常 → 回退普通跳转。
 * （参数按 react-router useNavigate 的 (to, options) 主形态取；避免其重载使泛型误判为 delta 数值重载。）
 */
export function startViewNavigation(
  navigate: (to: any, options?: any) => void,
  to: any,
  options?: any,
): void {
  const doc = document as StartViewTransitionDoc
  if (prefersReducedMotion() || typeof doc.startViewTransition !== 'function') {
    navigate(to, options)
    return
  }
  try {
    doc.startViewTransition(() => {
      flushSync(() => navigate(to, options))
    })
  } catch {
    navigate(to, options)
  }
}
