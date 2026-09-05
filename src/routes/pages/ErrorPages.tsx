import { Link } from 'react-router-dom'
import { useLocale } from '@/i18n'
import { Button } from '@/components/ui/button'

export function ForbiddenPage() {
  const { t } = useLocale()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-6xl font-bold text-muted-foreground">403</div>
      <h1 className="text-xl font-semibold">{t('errors.forbiddenTitle')}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t('errors.forbiddenHint')}</p>
      <Button asChild variant="outline">
        <Link to="/">{t('auth.backToExplore')}</Link>
      </Button>
    </div>
  )
}

export function NotFoundPage() {
  const { t } = useLocale()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-6xl font-bold text-muted-foreground">404</div>
      <h1 className="text-xl font-semibold">{t('errors.notFoundTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('errors.assetNotFoundHint')}</p>
      <Button asChild variant="outline">
        <Link to="/">{t('auth.backToExplore')}</Link>
      </Button>
    </div>
  )
}
