import { supabase } from '@/supabase/client'
import { downloadDashboardHtml } from '@/supabase/storage'
import { mergeCandidatesIntoHtml } from '@/lib/dashboardCandidateMerge'
import { normalizeToCanonicalHtml } from '@/lib/htmlNormalization'
import { invokeEdgeFunction } from '@/lib/edgeFunction'
import {
  ALLOWED_CSV_MIME_TYPES,
  ALLOWED_HTML_MIME_TYPES,
  ALLOWED_THUMBNAIL_MIME_TYPES,
  MAX_CSV_SIZE_BYTES,
  MAX_HTML_SIZE_BYTES,
  MAX_THUMBNAIL_SIZE_BYTES,
  STORAGE_BUCKET,
  STORAGE_FOLDER,
  THUMBNAIL_STORAGE_FOLDER,
} from '@/constants'
import type { Dashboard } from '@/types'

const EDIT_FUNCTION_NAME = 'dashboard-edit'

export interface UploadDashboardInput {
  title: string
  description?: string
  category?: string
  htmlFile: File
  thumbnailFile?: File | null
  createdBy: string
  onProgress?: (
    stage: 'normalizing' | 'html' | 'thumbnail' | 'saving',
    percent: number,
  ) => void
}

export function validateHtmlFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.html')) {
    return 'Only .html files are allowed.'
  }
  // Some platforms leave File#type empty for .html files; only reject when
  // the browser reports a *different*, non-HTML MIME type outright (e.g. a
  // renamed .svg/.js/.zip file), rather than trusting the extension alone.
  if (
    file.type &&
    !ALLOWED_HTML_MIME_TYPES.includes(
      file.type as (typeof ALLOWED_HTML_MIME_TYPES)[number],
    )
  ) {
    return 'File must be a valid HTML document.'
  }
  if (file.size > MAX_HTML_SIZE_BYTES) {
    return 'HTML file must be 10 MB or smaller.'
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

export function extensionFor(file: File): string {
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

  // Canonical HTML Normalization — the uploaded file is never stored (or
  // rendered) as-is. It's parsed, sanitized, and validated against the
  // production-tested canonical structure before anything touches Storage;
  // see src/lib/htmlNormalization/pipeline.ts for the full extract ->
  // sanitize -> canonicalize -> validate sequence and why each stage is
  // scoped the way it is. Runs before any Storage write (this function's
  // own try/catch below only exists to clean up PARTIAL uploads), so a
  // rejected file never creates orphaned Storage objects to begin with.
  input.onProgress?.('normalizing', 5)
  const { html: canonicalHtml } = await normalizeToCanonicalHtml(input.htmlFile)
  input.onProgress?.('normalizing', 10)

  const id = crypto.randomUUID()
  const storagePath = `${STORAGE_FOLDER}/${id}.html`
  const thumbnailPath = input.thumbnailFile
    ? `${THUMBNAIL_STORAGE_FOLDER}/${id}.${extensionFor(input.thumbnailFile)}`
    : null

  const uploadedPaths: string[] = []

  try {
    input.onProgress?.('html', 15)
    const { error: htmlUploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, new Blob([canonicalHtml], { type: 'text/html' }), {
        contentType: 'text/html',
      })
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

export function validateCsvFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return 'Only .csv files are allowed.'
  }
  // Same reasoning as validateHtmlFile: some platforms/exports leave
  // File#type empty or set it to a generic type for .csv files, so only
  // reject when the browser reports a MIME type that's clearly something
  // else entirely.
  if (
    file.type &&
    !ALLOWED_CSV_MIME_TYPES.includes(
      file.type as (typeof ALLOWED_CSV_MIME_TYPES)[number],
    )
  ) {
    return 'File must be a valid CSV.'
  }
  if (file.size > MAX_CSV_SIZE_BYTES) {
    return 'CSV file must be 10 MB or smaller.'
  }
  return null
}

export interface UpdateDashboardCandidatesInput {
  dashboardId: string
  csvFile: File
  onProgress?: (
    stage: 'downloading' | 'reading' | 'merging' | 'uploading' | 'saving',
    percent: number,
  ) => void
}

export interface UpdateDashboardCandidatesResult {
  dashboard: Dashboard
  existingCount: number
  appendedCount: number
  skippedCount: number
  finalTotal: number
}

/**
 * Appends new candidates (from an admin-uploaded CSV) into an
 * already-uploaded dashboard's HTML, in place of re-uploading a whole new
 * HTML file. Reuses the exact same merge algorithm as
 * scripts/merge-dashboard-candidates.mjs (src/lib/dashboardCandidateMerge.ts)
 * — this function is only responsible for the Storage/DB plumbing around
 * it: download the existing HTML, run the merge, upload the result to a
 * *new* storage path, then repoint the dashboard row at it.
 *
 * A new path (not an overwrite of the existing one) is used deliberately:
 * Supabase Storage objects are uploaded with a 1-hour Cache-Control header
 * by default, so overwriting the same path in place risks some viewers'
 * browsers serving a stale cached copy of the pre-merge HTML for up to an
 * hour. Writing to a new path and updating storage_path sidesteps that
 * entirely, and matches the existing upload flow's own UUID-per-file
 * convention.
 */
export async function updateDashboardCandidates(
  input: UpdateDashboardCandidatesInput,
): Promise<UpdateDashboardCandidatesResult> {
  const csvError = validateCsvFile(input.csvFile)
  if (csvError) throw new Error(csvError)

  input.onProgress?.('downloading', 5)
  const { data: dashboard, error: fetchError } = await supabase
    .from('dashboards')
    .select('*')
    .eq('id', input.dashboardId)
    .maybeSingle()
  if (fetchError) throw fetchError
  if (!dashboard) throw new Error('Dashboard not found.')

  const existingHtml = await downloadDashboardHtml(dashboard.storage_path)
  input.onProgress?.('downloading', 30)

  input.onProgress?.('reading', 35)
  const csvText = await input.csvFile.text()

  input.onProgress?.('merging', 50)
  const merge = mergeCandidatesIntoHtml(existingHtml, csvText)

  if (!merge.mergedHtml) {
    input.onProgress?.('saving', 100)
    return {
      dashboard,
      existingCount: merge.existingCount,
      appendedCount: 0,
      skippedCount: merge.skipped.length,
      finalTotal: merge.finalTotal,
    }
  }

  const newPath = `${STORAGE_FOLDER}/${crypto.randomUUID()}.html`

  input.onProgress?.('uploading', 65)
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(newPath, new Blob([merge.mergedHtml], { type: 'text/html' }), {
      contentType: 'text/html',
    })
  if (uploadError) throw uploadError

  try {
    input.onProgress?.('saving', 85)
    const { data: updated, error: updateError } = await supabase
      .from('dashboards')
      .update({ storage_path: newPath })
      .eq('id', dashboard.id)
      .select()
      .single()
    if (updateError) throw updateError

    // Best-effort cleanup of the previous HTML file — failure here doesn't
    // fail the whole operation, since the dashboard row already correctly
    // points at the new merged file; a leftover old object is just harmless
    // storage bloat, not a correctness issue.
    if (dashboard.storage_path !== newPath) {
      await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([dashboard.storage_path])
        .catch(() => undefined)
    }

    input.onProgress?.('saving', 100)
    return {
      dashboard: updated,
      existingCount: merge.existingCount,
      appendedCount: merge.appendedCount,
      skippedCount: merge.skipped.length,
      finalTotal: merge.finalTotal,
    }
  } catch (error) {
    await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([newPath])
      .catch(() => undefined)
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

export interface UpdateDashboardInput {
  dashboardId: string
  title: string
  description?: string | null
  category?: string | null
  /**
   * Omit entirely to leave the thumbnail untouched. A string replaces it
   * with that storage path; `null` removes it. Only a Super Admin request
   * may include this key at all — the dashboard-edit Edge Function rejects
   * it outright for Admin callers, even if the value would be a no-op.
   */
  thumbnail?: string | null
}

/**
 * Updates a dashboard's editable metadata via the dashboard-edit Edge
 * Function, which enforces (server-side, never trusting this call alone)
 * that an Admin may only edit dashboards assigned to them and may never
 * touch `thumbnail`, while a Super Admin may edit any dashboard including
 * its thumbnail. See that function's own module comment for the full rule
 * set. This call only ever updates the `dashboards` table row — the actual
 * Storage object for a Super Admin's thumbnail replace/remove is handled by
 * uploadDashboardThumbnail()/removeDashboardThumbnail() below, same as the
 * existing upload flow's direct-Storage-call pattern.
 */
export async function updateDashboard(
  input: UpdateDashboardInput,
): Promise<Dashboard> {
  const { dashboard } = await invokeEdgeFunction<{ dashboard: Dashboard }>(
    EDIT_FUNCTION_NAME,
    {
      action: 'update',
      payload: {
        dashboardId: input.dashboardId,
        title: input.title,
        description: input.description ?? '',
        category: input.category ?? '',
        // Conditionally spread: JSON.stringify drops an `undefined`-valued
        // key entirely, so omitting `thumbnail` here means the key never
        // reaches the Edge Function at all — the only way an Admin
        // caller's request can stay clean of it.
        ...(input.thumbnail !== undefined
          ? { thumbnail: input.thumbnail }
          : {}),
      },
    },
  )
  return dashboard
}

/**
 * Uploads a replacement thumbnail for an already-existing dashboard
 * (Super Admin only — client-side, RLS-permitted the same way the initial
 * upload's thumbnail write already is). Always writes to a brand-new path
 * rather than overwriting the dashboard's existing one, for the same
 * stale-Cache-Control reason documented on updateDashboardCandidates: the
 * caller is responsible for pointing the dashboard row at this new path
 * (via updateDashboard) and then best-effort deleting the old one on
 * success.
 */
export async function uploadDashboardThumbnail(
  dashboardId: string,
  file: File,
): Promise<string> {
  const error = validateThumbnailFile(file)
  if (error) throw new Error(error)

  const path = `${THUMBNAIL_STORAGE_FOLDER}/${dashboardId}-${crypto.randomUUID()}.${extensionFor(file)}`
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, { contentType: file.type })
  if (uploadError) throw uploadError

  return path
}

/** Best-effort removal of a previous thumbnail Storage object — failure
 * here doesn't matter to the caller: the dashboard row has already been
 * repointed (or cleared) by the time this runs, so a leftover old object is
 * just harmless storage bloat, same reasoning as updateDashboardCandidates'
 * own cleanup step. */
export async function removeDashboardThumbnailObject(
  path: string,
): Promise<void> {
  await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([path])
    .catch(() => undefined)
}
