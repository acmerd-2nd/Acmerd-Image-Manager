import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LogOut, User } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthProvider'
import { getSiteSettings } from '@/features/settings/api'
import { brandLogoUrl } from '@/lib/image-source'
import { useLocale } from '@/i18n'
import { LocaleSwitch } from '@/components/LocaleSwitch'
import { CreditsBadge } from '@/components/CreditsBadge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

export function AppShell() {
  const { session, isAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const { t } = useLocale()
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  // V1.4 站点品牌（导航文字 + 浏览器标题 + Logo；读失败回落硬编码默认）
  const [brandText, setBrandText] = useState('AcmerdImage')
  const [brandLogoPath, setBrandLogoPath] = useState('')

  // V1.1 PC-3：排期导航显隐由 site_settings.schedule_navigation_enabled 控制（anon 可读）
  useEffect(() => {
    let cancelled = false
    getSiteSettings()
      .then((s) => {
        if (cancelled) return
        setScheduleEnabled(s.schedule_navigation_enabled)
        // V1.4：品牌设置（缺省回落硬编码默认，符合产品态）
        setBrandText(s.brand_text || 'AcmerdImage')
        setBrandLogoPath(s.brand_logo_path || '')
        document.title = s.brand_title || 'AcmerdImage'
      })
      .catch(() => {
        /* 读失败按隐藏处理（默认 false 语义） */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2">
              {brandLogoPath ? (
                <img src={brandLogoUrl(brandLogoPath)} alt={brandText} className="h-8 w-auto" />
              ) : (
                <span className="text-lg font-bold tracking-tight">{brandText}</span>
              )}
            </Link>
            <LocaleSwitch className="hidden sm:flex" />
            <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground sm:flex">
              <NavLink to="/" end className={({ isActive }) => cn(isActive && 'text-foreground')}>
                {t('nav.explore')}
              </NavLink>
              <NavLink to="/search" className={({ isActive }) => cn(isActive && 'text-foreground')}>
                {t('nav.search')}
              </NavLink>
              {scheduleEnabled && (
                <NavLink
                  to="/schedule"
                  className={({ isActive }) => cn(isActive && 'text-foreground')}
                >
                  {t('nav.schedule')}
                </NavLink>
              )}
              {isAdmin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    cn('font-semibold text-foreground', isActive && 'underline')
                  }
                >
                  {t('nav.admin')}
                </NavLink>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {session ? (
              <>
                <CreditsBadge />
                <Button asChild variant="ghost" size="sm">
                  <Link to="/profile" className="flex items-center gap-1.5">
                    <User className="h-4 w-4" />
                    {t('nav.profile')}
                  </Link>
                </Button>
                <Button variant="ghost" size="sm" onClick={handleSignOut}>
                  <LogOut className="h-4 w-4" />
                  {t('nav.logout')}
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/login">{t('nav.login')}</Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/register">{t('nav.register')}</Link>
                </Button>
              </>
            )}
          </div>
        </div>
        {/* 移动端：切换器次级位置（桌面在品牌旁） */}
        <div className="flex justify-start px-4 pb-2 sm:hidden">
          <LocaleSwitch />
        </div>
      </header>

      <main className="flex-1">
        <Suspense fallback={<div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="border-t py-6">
        <div className="mx-auto w-full max-w-7xl px-4 text-center text-xs text-muted-foreground sm:px-6">
          {t('home.footerTagline')}
        </div>
      </footer>
    </div>
  )
}
