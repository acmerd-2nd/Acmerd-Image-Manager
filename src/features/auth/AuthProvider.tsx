import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { AppRole } from '@/types/database'

interface AuthState {
  session: Session | null
  user: User | null
  role: AppRole | null
  loading: boolean
  /** role 查询进行中（守卫必须等它结束，否则登录后瞬间误判 403） */
  roleLoading: boolean
  isAdmin: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<AppRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [roleLoading, setRoleLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      // 初始就有 session 时，role 查询即将开始 —— 同步标记，避免守卫读到中间态
      if (data.session) setRoleLoading(true)
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      // 必须与 setSession 同批同步更新：守卫可能在新 session 生效的同一帧渲染，
      // 若此时 roleLoading 仍为 false 会被误判为 "角色已确认不是 admin" → 错跳 403
      setSession(newSession)
      if (newSession) {
        setRoleLoading(true)
      } else {
        setRole(null)
        setRoleLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // RLS 只允许查看自己的 user_roles 行
  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) {
      setRole(null)
      setRoleLoading(false)
      return
    }
    setRoleLoading(true)
    supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle()
      .then(
        ({ data }) => {
          setRole((data?.role as AppRole) ?? 'user')
          setRoleLoading(false)
        },
        () => {
          // 查询失败按安全方向兜底：当作普通 user（admin 会得到 403，不会误放行）
          setRole('user')
          setRoleLoading(false)
        },
      )
  }, [session])

  const signOut = async () => {
    await supabase.auth.signOut()
    setSession(null)
    setRole(null)
    setRoleLoading(false)
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        role,
        loading,
        roleLoading,
        isAdmin: role === 'admin',
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
