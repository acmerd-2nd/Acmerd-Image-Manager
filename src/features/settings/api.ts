import { supabase } from '@/lib/supabase/client'

/**
 * V1.1 PC-3：site_settings 只读访问（0011：anon/authenticated 可读，写仅 Worker service_role）。
 * PC-4 下载按钮成本透出、AppShell 排期导航显隐均从这里取值。
 * 读取失败由调用方兜底（关键开关缺省 false = 隐藏，符合默认产品态）。
 */
export interface SiteSettings {
  registration_enabled: boolean
  schedule_navigation_enabled: boolean
  single_image_download_cost: number
  zip_download_cost_per_image: number
  package_download_cost: number
}

export async function getSiteSettings(): Promise<SiteSettings> {
  const { data, error } = await supabase.from('site_settings').select('key, value')
  if (error) throw new Error(error.message)
  const map = new Map<string, unknown>(
    ((data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]),
  )
  return {
    registration_enabled: map.get('registration_enabled') === true,
    schedule_navigation_enabled: map.get('schedule_navigation_enabled') === true,
    single_image_download_cost: Number(map.get('single_image_download_cost') ?? 1),
    zip_download_cost_per_image: Number(map.get('zip_download_cost_per_image') ?? 1),
    package_download_cost: Number(map.get('package_download_cost') ?? 15),
  }
}
