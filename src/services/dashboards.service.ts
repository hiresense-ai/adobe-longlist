import { supabase } from '@/supabase/client'
import { getThumbnailSignedUrl } from '@/supabase/storage'
import type { Dashboard } from '@/types'

export type DashboardWithThumbnail = Dashboard & { thumbnailUrl: string | null }

export async function listDashboards(): Promise<DashboardWithThumbnail[]> {
  const { data, error } = await supabase
    .from('dashboards')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error

  return Promise.all(
    data.map(async (dashboard) => ({
      ...dashboard,
      thumbnailUrl: await getThumbnailSignedUrl(dashboard.thumbnail),
    })),
  )
}

export async function getDashboardById(id: string): Promise<Dashboard | null> {
  const { data, error } = await supabase
    .from('dashboards')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

export function filterDashboards(
  dashboards: DashboardWithThumbnail[],
  query: string,
): DashboardWithThumbnail[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return dashboards

  return dashboards.filter((dashboard) =>
    [dashboard.title, dashboard.description, dashboard.category]
      .filter(Boolean)
      .some((field) => field!.toLowerCase().includes(normalized)),
  )
}
