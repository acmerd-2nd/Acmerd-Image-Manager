import { Link } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export function ProfilePage() {
  const { user, role, signOut } = useAuth()

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user?.email ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Role</span>
            <Badge variant={role === 'admin' ? 'default' : 'secondary'}>{role ?? '…'}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Profile editing and password settings arrive in Phase 2.
          </p>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" asChild>
              <Link to="/">Back to Explore</Link>
            </Button>
            <Button variant="destructive" onClick={signOut}>
              Logout
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
