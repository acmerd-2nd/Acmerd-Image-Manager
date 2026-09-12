import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Camera, Trash2, User } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/features/auth/AuthProvider'
import { CreditsLedger } from '@/features/credits/CreditsLedger'
import { AvatarCropperDialog } from '@/components/AvatarCropperDialog'
import { uploadAvatar, deleteAvatar } from '@/features/profile/api'
import { useLocale } from '@/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/spinner'

export function ProfilePage() {
  const { user, role, signOut, avatarUrl, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const { t } = useLocale()

  const [displayName, setDisplayName] = useState('')
  const [loadingProfile, setLoadingProfile] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // V1.8.0 头像：选中的原始文件 → 裁剪弹窗 → 上传
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [cropperFile, setCropperFile] = useState<File | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)

  const ACCEPTED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp']
  const MAX_AVATAR_SOURCE_SIZE = 10 * 1024 * 1024 // 原图上限（裁剪前）；上传体积由裁剪保证

  const pickAvatar = () => fileInputRef.current?.click()

  const onFileChosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许再次选择同一文件
    if (!file) return
    setAvatarMessage(null)
    setAvatarError(null)
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setAvatarError(t('auth.avatar.badFormat'))
      return
    }
    if (file.size > MAX_AVATAR_SOURCE_SIZE) {
      setAvatarError(t('auth.avatar.sourceTooLarge'))
      return
    }
    setCropperFile(file)
  }

  const onCropped = async (cropped: File) => {
    setAvatarBusy(true)
    setAvatarError(null)
    try {
      await uploadAvatar(cropped)
      refreshProfile() // 令右上角头像即时更新
      setCropperFile(null)
      setAvatarMessage(t('auth.avatar.uploaded'))
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : t('auth.avatar.uploadFailed'))
    } finally {
      setAvatarBusy(false)
    }
  }

  const onRemoveAvatar = async () => {
    if (!window.confirm(t('auth.avatar.removeConfirm'))) return
    setAvatarBusy(true)
    setAvatarError(null)
    setAvatarMessage(null)
    try {
      await deleteAvatar()
      refreshProfile()
      setAvatarMessage(t('auth.avatar.removed'))
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : t('auth.avatar.removeFailed'))
    } finally {
      setAvatarBusy(false)
    }
  }

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
          {/* V1.8.0 头像：预览 + 选择本地图片（弹裁剪窗）+ 移除 */}
          <div className="flex items-center gap-4 border-b pb-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-border">
              {avatarUrl ? (
                <img src={avatarUrl} alt={t('auth.avatar.alt')} className="h-full w-full object-cover" />
              ) : (
                <User className="h-7 w-7 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={onFileChosen}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={pickAvatar} disabled={avatarBusy}>
                  <Camera className="h-4 w-4" />
                  {avatarUrl ? t('auth.avatar.change') : t('auth.avatar.choose')}
                </Button>
                {avatarUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onRemoveAvatar}
                    disabled={avatarBusy}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('auth.avatar.remove')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('auth.avatar.hint')}</p>
              {avatarBusy && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5" />
                  {t('auth.avatar.uploading')}
                </p>
              )}
              {avatarMessage && <p className="text-xs text-success">{avatarMessage}</p>}
              {avatarError && <p className="text-xs text-destructive">{avatarError}</p>}
            </div>
          </div>

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
              {saveMessage && <p className="text-xs text-success">{saveMessage}</p>}
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

          {/* V1.3 C1：积分流水自助查看（本人 RLS 只读；Admin 亦可见自己流水，语义一致） */}
          <CreditsLedger />
        </CardContent>
      </Card>

      {cropperFile && (
        <AvatarCropperDialog
          file={cropperFile}
          onCancel={() => setCropperFile(null)}
          onConfirm={onCropped}
        />
      )}
    </div>
  )
}
