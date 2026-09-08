import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Link, matchPath, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * 站点面包屑（用户端 + 后台两端通用）。
 * - BreadcrumbProvider：持有「动态末级名称」leafName，供详情/编辑器页在加载到数据后写入真实名称。
 * - useBreadcrumb()：页面（资产/合集/后台资产编辑页）用它设置末级标签，卸载/切换路由时复位，避免名称串台。
 * - Breadcrumbs：根据当前路径用 matchPath 推导层级；父级为可点击 <Link>，末级高亮且不可点。
 */

export interface Crumb {
  /** 展示文案 */
  label: string
  /** 存在表示可点击跳转；缺省表示当前页（末级）不可点 */
  to?: string
}

interface BreadcrumbContextValue {
  leafName: string | null
  setLeafName: (name: string | null) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null)

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [leafName, setLeafName] = useState<string | null>(null)
  const value = useMemo<BreadcrumbContextValue>(() => ({ leafName, setLeafName }), [leafName])
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>
}

export function useBreadcrumb(): BreadcrumbContextValue {
  const ctx = useContext(BreadcrumbContext)
  if (!ctx) {
    throw new Error('useBreadcrumb must be used within a <BreadcrumbProvider>')
  }
  return ctx
}

/**
 * 由当前路径推导面包屑层级。
 * 返回 null 表示无需渲染（如首页/探索根路径，trail 仅 1 项）。
 * leafName 为详情/编辑页写入的动态末级真实名称，缺失时回落对应 i18n 标签。
 */
function buildTrail(
  pathname: string,
  t: (key: string) => string,
  leafName: string | null,
): Crumb[] | null {
  // ---- 后台端（/admin 下）----
  if (matchPath({ path: '/admin/*' }, pathname)) {
    const adminRoot: Crumb = { label: t('nav.admin'), to: '/admin' }
    if (
      matchPath({ path: '/admin/dashboard', end: true }, pathname) ||
      matchPath({ path: '/admin', end: true }, pathname)
    ) {
      return [adminRoot, { label: t('admin.page.dashboard') }]
    }
    if (matchPath({ path: '/admin/collections', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.collections') }]
    }
    if (matchPath({ path: '/admin/schedule', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.schedule') }]
    }
    // 注意：/admin/assets/new 必须优先于 /admin/assets/:id（精确匹配优先，否则 new 会被 :id 命中）
    if (matchPath({ path: '/admin/assets/new', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.assets'), to: '/admin/assets' }, { label: t('breadcrumb.newAsset') }]
    }
    if (matchPath({ path: '/admin/assets/:id', end: true }, pathname)) {
      return [
        adminRoot,
        { label: t('admin.page.assets'), to: '/admin/assets' },
        { label: leafName ?? t('breadcrumb.editAsset') },
      ]
    }
    if (matchPath({ path: '/admin/assets', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.assets') }]
    }
    if (matchPath({ path: '/admin/users', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.users') }]
    }
    if (matchPath({ path: '/admin/tags', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.tags') }]
    }
    if (matchPath({ path: '/admin/storage', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.storage') }]
    }
    if (matchPath({ path: '/admin/audit-logs', end: true }, pathname)) {
      return [adminRoot, { label: t('admin.page.auditLogs') }]
    }
    // 未知后台子路径回落到 dashboard
    return [adminRoot, { label: t('admin.page.dashboard') }]
  }

  // ---- 用户端 ----
  const explore: Crumb = { label: t('nav.explore'), to: '/' }
  if (
    matchPath({ path: '/', end: true }, pathname) ||
    matchPath({ path: '/explore', end: true }, pathname)
  ) {
    // 仅「探索」一项，渲染无意义 → 返回单项供外层判定为 null
    return [explore]
  }
  if (matchPath({ path: '/search', end: true }, pathname)) {
    return [explore, { label: t('nav.search') }]
  }
  if (matchPath({ path: '/asset/:slug', end: true }, pathname)) {
    return [explore, { label: leafName ?? t('breadcrumb.asset') }]
  }
  if (matchPath({ path: '/collection/:slug', end: true }, pathname)) {
    return [explore, { label: leafName ?? t('breadcrumb.collection') }]
  }
  if (matchPath({ path: '/schedule', end: true }, pathname)) {
    return [explore, { label: t('nav.schedule') }]
  }
  if (matchPath({ path: '/profile', end: true }, pathname)) {
    return [explore, { label: t('nav.profile') }]
  }
  if (matchPath({ path: '/login', end: true }, pathname)) {
    return [explore, { label: t('nav.login') }]
  }
  if (matchPath({ path: '/register', end: true }, pathname)) {
    return [explore, { label: t('nav.register') }]
  }
  if (matchPath({ path: '/reset-password/confirm', end: true }, pathname)) {
    return [explore, { label: t('breadcrumb.resetPassword') }]
  }
  if (matchPath({ path: '/reset-password', end: true }, pathname)) {
    return [explore, { label: t('breadcrumb.resetPassword') }]
  }
  if (matchPath({ path: '/403', end: true }, pathname)) {
    return [explore, { label: t('errors.forbiddenTitle') }]
  }
  // 兜底（如 NotFound *）：仅「探索」一项
  return [explore]
}

export function Breadcrumbs() {
  const location = useLocation()
  const { t } = useLocale()
  const { leafName } = useBreadcrumb()
  const trail = buildTrail(location.pathname, t, leafName)

  // 仅首页/探索根路径（trail ≤ 1）不渲染
  if (!trail || trail.length <= 1) return null

  return (
    <nav aria-label="Breadcrumb">
      <div className="mx-auto w-full max-w-7xl px-4 py-2 sm:px-6">
        <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {trail.map((crumb, index) => {
            const isLast = index === trail.length - 1
            return (
              <li key={`${crumb.to ?? crumb.label}-${index}`} className="flex items-center gap-1.5">
                {index > 0 && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                {crumb.to && !isLast ? (
                  <Link to={crumb.to} className="transition-colors hover:text-foreground hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={cn('font-medium', isLast ? 'text-foreground' : 'text-muted-foreground')}>
                    {crumb.label}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </nav>
  )
}
