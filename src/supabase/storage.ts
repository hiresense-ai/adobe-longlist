import { supabase } from './client'
import { STORAGE_BUCKET, STORAGE_FOLDER } from '@/constants'

/** Downloads an HTML dashboard file's raw text content from Supabase Storage. */
export async function downloadDashboardHtml(
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath)

  if (error) throw error
  return data.text()
}

/** Creates a short-lived signed URL, used for thumbnail previews on dashboard cards. */
export async function getThumbnailSignedUrl(
  path: string | null,
  expiresInSeconds = 3600,
): Promise<string | null> {
  if (!path) return null

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds)

  if (error) return null
  return data.signedUrl
}

export async function listDashboardFiles(folder: string = STORAGE_FOLDER) {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(folder, { sortBy: { column: 'name', order: 'asc' } })

  if (error) throw error
  return data
}
