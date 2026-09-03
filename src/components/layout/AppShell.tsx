import { Suspense } from 'react'
import { NavLink, Link, Outlet, useNavigate } from 'react-router-dom'
import { LogOut, User } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/spinner'
import { cn } from '@/lib/utils'

export function AppShell() {
  const { session, isAdmin, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-[0.18em] text-muted-foreground">
                ACMERD
              </span>
              <span className="text-lg font-bold tracking-tight">探知</span>
            </Link>
            <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground sm:flex">
              <NavLink
                to="/"
                end
                className={({ isActive }) => cn(isActive && 'text-foreground')}
              >
                Explore
              </NavLink>
              <NavLink
                to="/search"
                className={({ isActive }) => cn(isActive && 'text-foreground')}
              >
                Search
              </NavLink>
              {isAdmin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    cn('font-semibold text-foreground', isActive && 'underline')
                  }
                >
                  Admin
                </NavLink>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {session ? (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/profile" className="flex items-center gap-1.5">
                    <User className="h-4 w-4" />
                    Profile
                  </Link>
                </Button>
                <Button variant="ghost" size="sm" onClick={handleSignOut}>
                  <LogOut className="h-4 w-4" />
                  Logout
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/login">Login</Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/register">Register</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Suspense fallback={<div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="border-t py-6">
        <div className="mx-auto w-full max-w-7xl px-4 text-center text-xs text-muted-foreground sm:px-6">
          ACMERD · 探知 — Research · Discover · Create
        </div>
      </footer>
    </div>
  )
}
