import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { Spinner } from '@/components/spinner'

/** 需要登录（USER 及以上） */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return <FullPageSpinner />
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <>{children}</>
}

/** 需要 ADMIN；USER 与 GUEST 分别得到明确拒绝 */
export function RequireRole({
  allow,
  children,
}: {
  allow: Array<'user' | 'admin'>
  children: ReactNode
}) {
  const { session, role, loading, roleLoading } = useAuth()
  const location = useLocation()

  if (loading || roleLoading || (session && !role)) return <FullPageSpinner />
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  if (!role || !allow.includes(role)) return <Navigate to="/403" replace />
  return <>{children}</>
}

function FullPageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}
