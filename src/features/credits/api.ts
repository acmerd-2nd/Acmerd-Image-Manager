import { supabase } from '@/lib/supabase/client'
import type { CreditTransactionRow } from '@/types/database'

/**
 * V1.3 C1-C3：用户积分流水自助查看（纯读，零新端点）。
 * 数据面 = 既有 RLS `select own`（0010），客户端直读 credit_transactions；
 * 分页 = limit 50 + 加载更多（range 递增；C2）；排序 created_at desc。
 */

export const LEDGER_PAGE_SIZE = 50

export async function listOwnTransactions(
  userId: string,
  offset: number,
): Promise<{ rows: CreditTransactionRow[]; hasMore: boolean }> {
  // 显式 user_id 过滤：普通用户本已被 RLS 限定本人；admin 的 RLS 是 own-or-is_admin（可见全量），
  // 本组件语义是"自助查看自己流水"，故对所有角色都显式收窄到本人。
  const { data, error } = await supabase
    .from('credit_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + LEDGER_PAGE_SIZE - 1)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as CreditTransactionRow[]
  return { rows, hasMore: rows.length === LEDGER_PAGE_SIZE }
}
