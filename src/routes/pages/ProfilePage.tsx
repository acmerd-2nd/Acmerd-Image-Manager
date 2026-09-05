import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/spinner'

export function ProfilePage() {
  const { user, role, signOut } = useAuth()
  const navigate = useNavigate()
  const { t } = useLocale()

  const [displayName, setDisplayName] = useState('')
  const [loadingProfile, setLoadingProfile] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // RLS 限定本人行可 SELECT/UPDATE（0001 策略），此处只可能读到自己的 profile
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user?.id ?? '')
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setDisplayName(data?.display_name ?? '')
          setLoadingProfile(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    if (!user) return
    setSaving(true)
    setSaveMessage(null)
    setSaveError(null)

    const trimmed = displayName.trim()
    if (trimmed.length > 50) {
      setSaveError(t('auth.displayNameTooLong'))
      setSaving(false)
      return
    }

    const { error } = await supabase
      .from('profiles')
      .update({ display_name: trimmed || null })
      .eq('id', user.id)

    if (error) {
      setSaveError(t('auth.saveFailed', { msg: error.message }))
    } else {
      setSaveMessage(t('common.saved'))
    }
    setSaving(false)
  }

  const handleSignOut = async () => {
    await signOut()
    // signOut 已由 AuthProvider 清空 session/role（supabase-js 同步移除本地存储）
    navigate('/')
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>{t('auth.profileTitle')}</CardTitle>
          <CardDescription>{t('auth.profileSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('auth.email')}</span>
            <span className="font-medium">{user?.email ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('auth.role')}</span>
            <Badge variant={role === 'admin' ? 'default' : 'secondary'}>{role ?? '…'}</Badge>
          </div>

          {loadingProfile ? (
            <div className="flex justify-center py-2">
              <Spinner className="h-5 w-5" />
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-2 border-t pt-4">
              <label htmlFor="display-name" className="text-sm font-medium">
                {t('auth.displayName')}
              </label>
              <div className="flex gap-2">
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={50}
                  placeholder={t('auth.displayName')}
                />
                <Button type="submit" disabled={saving}>
                  {saving ? <Spinner className="h-4 w-4" /> : t('common.save')}
                </Button>
              </div>
              {saveMessage && <p className="text-xs text-green-600">{saveMessage}</p>}
              {saveError && <p className="text-xs text-destructive">{saveError}</p>}
              <p className="text-xs text-muted-foreground">{t('auth.displayNameHint')}</p>
            </form>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" asChild>
              <Link to="/">{t('auth.backToExplore')}</Link>
            </Button>
            <Button variant="destructive" onClick={handleSignOut}>
              {t('nav.logout')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
