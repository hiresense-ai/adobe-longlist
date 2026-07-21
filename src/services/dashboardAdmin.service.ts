import { supabase } from '@/supabase/client'
import {
  ALLOWED_THUMBNAIL_MIME_TYPES,
  MAX_THUMBNAIL_SIZE_BYTES,
  STORAGE_BUCKET,
  STORAGE_FOLDER,
  THUMBNAIL_STORAGE_FOLDER,
} from '@/constants'
import type { Dashboard } from '@/types'

export interface UploadDashboardInput {
  title: string
  description?: string
  category?: string
  htmlFile: File
  thumbnailFile?: File | null
  createdBy: string
  onProgress?: (stage: 'html' | 'thumbnail' | 'saving', percent: number) => void
}

export function validateHtmlFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.html')) {
    return 'Only .html files are allowed.'
  }
  return null
}

export function validateThumbnailFile(file: File): string | null {
  if (
    !ALLOWED_THUMBNAIL_MIME_TYPES.includes(
      file.type as (typeof ALLOWED_THUMBNAIL_MIME_TYPES)[number],
    )
  ) {
    return 'Image must be JPG, JPEG, PNG, or WEBP.'
  }
  if (file.size > MAX_THUMBNAIL_SIZE_BYTES) {
    return 'Image must be 5 MB or smaller.'
  }
  return null
}

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()
  if (fromName) return fromName.toLowerCase()
  return file.type.split('/').pop() ?? 'bin'
}

export async function uploadDashboard(
  input: UploadDashboardInput,
): Promise<Dashboard> {
  const htmlError = validateHtmlFile(input.htmlFile)
  if (htmlError) throw new Error(htmlError)

  if (input.thumbnailFile) {
    const thumbnailError = validateThumbnailFile(input.thumbnailFile)
    if (thumbnailError) throw new Error(thumbnailError)
  }

  const id = crypto.randomUUID()
  const storagePath = `${STORAGE_FOLDER}/${id}.html`
  const thumbnailPath = input.thumbnailFile
    ? `${THUMBNAIL_STORAGE_FOLDER}/${id}.${extensionFor(input.thumbnailFile)}`
    : null

  const uploadedPaths: string[] = []

  try {
    input.onProgress?.('html', 10)
    const { error: htmlUploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, input.htmlFile, { contentType: 'text/html' })
    if (htmlUploadError) throw htmlUploadError
    uploadedPaths.push(storagePath)
    input.onProgress?.('html', 45)

    if (input.thumbnailFile && thumbnailPath) {
      input.onProgress?.('thumbnail', 55)
      const { error: thumbnailUploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(thumbnailPath, input.thumbnailFile, {
          contentType: input.thumbnailFile.type,
        })
      if (thumbnailUploadError) throw thumbnailUploadError
      uploadedPaths.push(thumbnailPath)
      input.onProgress?.('thumbnail', 85)
    }

    input.onProgress?.('saving', 92)
    const { data, error: insertError } = await supabase
      .from('dashboards')
      .insert({
        title: input.title,
        description: input.description || null,
        category: input.category || null,
        file_name: input.htmlFile.name,
        storage_path: storagePath,
        thumbnail: thumbnailPath,
        created_by: input.createdBy,
      })
      .select()
      .single()

    if (insertError) throw insertError

    input.onProgress?.('saving', 100)
    return data
  } catch (error) {
    if (uploadedPaths.length) {
      await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths)
    }
    throw error
  }
}

export async function deleteDashboard(
  dashboard: Pick<Dashboard, 'id' | 'storage_path' | 'thumbnail'>,
): Promise<void> {
  const pathsToRemove = [dashboard.storage_path, dashboard.thumbnail].filter(
    (path): path is string => Boolean(path),
  )

  if (pathsToRemove.length) {
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(pathsToRemove)
    if (storageError) throw storageError
  }

  const { error } = await supabase
    .from('dashboards')
    .delete()
    .eq('id', dashboard.id)
  if (error) throw error
}
