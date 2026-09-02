import { useAuth } from '@/features/auth/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function Placeholder({ title }: { title: string }) {
  const { isAdmin } = useAuth()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          This console area is scaffolded in Phase 1 and becomes functional in Phase 3–7
          {isAdmin ? '.' : ' (admin only).'}
        </p>
      </CardContent>
    </Card>
  )
}

export const AdminDashboardPage = () => <Placeholder title="Dashboard" />
export const AdminUsersPage = () => <Placeholder title="Users" />
export const AdminTagsPage = () => <Placeholder title="Tags" />
export const AdminStoragePage = () => <Placeholder title="Storage" />
export const AdminAuditLogsPage = () => <Placeholder title="Audit Logs" />
export const AdminSettingsPage = () => <Placeholder title="Settings" />
