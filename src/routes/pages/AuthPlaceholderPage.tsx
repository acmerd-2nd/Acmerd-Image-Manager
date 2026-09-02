import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/AuthProvider'
import { Navigate } from 'react-router-dom'

/** Phase 2 实装真实注册/登录；Phase 1 仅占位 */
export function AuthPlaceholderPage({ mode }: { mode: 'login' | 'register' }) {
  const { session } = useAuth()
  if (session) return <Navigate to="/" replace />

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>{mode === 'login' ? 'Login' : 'Register'}</CardTitle>
          <CardDescription>
            {mode === 'login'
              ? 'Sign in to download assets.'
              : 'Create an account to download assets.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Authentication is implemented in Phase 2.
        </CardContent>
      </Card>
    </div>
  )
}
