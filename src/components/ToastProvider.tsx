import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 全局 Toast（Phase 9 D6）：自建、零运行时 UI 依赖。
 * 最小统一行为：success / error / info + 自动消失 + 手动关闭 + 多条堆叠不互相覆盖。
 */
type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}
interface ToastApi {
  success: (m: string) => void
  error: (m: string) => void
  info: (m: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)
const AUTO_DISMISS_MS = 4000
let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq
    setItems((prev) => [...prev, { id, kind, message }])
  }, [])
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const api: ToastApi = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 p-4">
        {items.map((t) => (
          <ToastRow key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const Icon = item.kind === 'success' ? CheckCircle2 : item.kind === 'error' ? XCircle : Info
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg px-4 py-2.5 text-sm shadow-lg',
        item.kind === 'success' && 'bg-green-600 text-white',
        item.kind === 'error' && 'bg-destructive text-destructive-foreground',
        item.kind === 'info' && 'bg-foreground text-background',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{item.message}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 opacity-80 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
