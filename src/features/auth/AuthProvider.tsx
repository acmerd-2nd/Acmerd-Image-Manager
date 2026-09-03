import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { AppRole } from '@/types/database'

interface AuthState {
  session: Session | null
  user: User | null
  /** 生效角色：disabled=true 时按 'user' 处理（不进入 admin 路由/守卫） */
  role: AppRole | null
  loading: boolean
  /** role/disabled 查询进行中（守卫必须等它结束，否则登录后瞬间误判 403） */
  roleLoading: boolean
  /** 本人 profiles.disabled（D2 对偶；仅影响身份展示与守卫，不触碰业务查询通道） */
  disabled: boolean
  isDisabled: boolean
  isAdmin: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<AppRole | null>(null)
  const [disabled, setDisabled] = useState(false)
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
        setDisabled(false)
        setRoleLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // RLS 允许查看自己的 user_roles 行与自己的 profiles 行；
  // 并行取 role + disabled，一次判定生效身份（Phase 7 D2）。
  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) {
      setRole(null)
      setDisabled(false)
      setRoleLoading(false)
      return
    }
    setRoleLoading(true)
    Promise.all([
      supabase.from('user_roles').select('role').eq('user_id', userId).maybeSingle(),
      supabase.from('profiles').select('disabled').eq('id', userId).maybeSingle(),
    ]).then(
      ([roleRes, profRes]) => {
        const dbRole = (roleRes.data?.role as AppRole) ?? 'user'
        const isDisabled = profRes.data?.disabled === true
        setDisabled(isDisabled)
        // disabled=true → 身份按"非 admin"处理：即使 DB 角色为 admin 也降为 user，
        // 使 RequireRole(['admin']) 等守卫直接拒绝，且不触碰任何业务查询通道。
        setRole(isDisabled ? 'user' : dbRole)
        setRoleLoading(false)
      },
      () => {
        // 查询失败按安全方向兜底：当作普通 user（admin 会得到 403，不会误放行）
        setRole('user')
        setDisabled(false)
        setRoleLoading(false)
      },
    )
  }, [session])

  const signOut = async () => {
    await supabase.auth.signOut()
    setSession(null)
    setRole(null)
    setDisabled(false)
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
        disabled,
        isDisabled: disabled,
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
