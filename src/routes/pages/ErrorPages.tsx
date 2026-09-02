import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function ForbiddenPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-6xl font-bold text-muted-foreground">403</div>
      <h1 className="text-xl font-semibold">Access denied</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        You do not have permission to view this page. If you believe this is a mistake, contact the
        administrator.
      </p>
      <Button asChild variant="outline">
        <Link to="/">Back to Explore</Link>
      </Button>
    </div>
  )
}

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-6xl font-bold text-muted-foreground">404</div>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you are looking for does not exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to Explore</Link>
      </Button>
    </div>
  )
}
