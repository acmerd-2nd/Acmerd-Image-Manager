import { Suspense } from 'react'
import { NavLink, Link, Outlet } from 'react-router-dom'
import { FolderOpen, LayoutDashboard, ScrollText, Tags, Users, Database } from 'lucide-react'
import { useLocale } from '@/i18n'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

const items = [
  { to: '/admin/dashboard', labelKey: 'admin.page.dashboard', icon: LayoutDashboard },
  { to: '/admin/assets', labelKey: 'admin.page.assets', icon: FolderOpen },
  { to: '/admin/users', labelKey: 'admin.page.users', icon: Users },
  { to: '/admin/tags', labelKey: 'admin.page.tags', icon: Tags },
  { to: '/admin/storage', labelKey: 'admin.page.storage', icon: Database },
  { to: '/admin/audit-logs', labelKey: 'admin.page.auditLogs', icon: ScrollText },
] as const

export function AdminLayout() {
  const { t } = useLocale()
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      <aside className="hidden w-56 shrink-0 border-r bg-muted/40 md:block">
        <div className="sticky top-14 flex h-[calc(100vh-3.5rem)] flex-col p-4">
          <div className="mb-4 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admin Console
          </div>
          <nav className="flex flex-col gap-1">
            {items.map(({ to, labelKey, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                    isActive && 'bg-accent text-accent-foreground',
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {t(labelKey)}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto px-2 text-xs text-muted-foreground">
            <Link to="/" className="hover:underline">
              {t('admin.backToSite')}
            </Link>
          </div>
        </div>
      </aside>
      {/* min-w-0：允许 flex 子项收缩至内容宽度以下，使页内 overflow-x-auto 容器真正生效，
          防止宽表格（Users/Audit Logs）在移动/平板视口把溢出转移到页面级（G9 第④类证据发现） */}
      <div className="min-w-0 flex-1 p-6">
        {/* 移动端简易导航（Phase 9 响应式再完善） */}
        <nav className="mb-4 flex flex-wrap gap-2 md:hidden">
          {items.map(({ to, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium',
                  isActive && 'bg-accent',
                )
              }
            >
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>
        <Suspense fallback={<div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  )
}
