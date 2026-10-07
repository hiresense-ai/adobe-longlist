import { ServerOff } from 'lucide-react'

/**
 * Shown INSTEAD of the app when this page's workspace has no valid backend
 * configuration (src/supabase/workspaceConfig.ts) — e.g. /lyca/... on a
 * deployment that has no Lyca project configured yet. Fail closed: no
 * Supabase client exists on this page, and nothing falls back to another
 * client's backend.
 */
export function WorkspaceUnavailable({
  appName,
  reason,
}: {
  appName: string
  reason: string
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/10 text-white/70">
          <ServerOff className="size-6" />
        </div>
        <h1 className="text-lg font-semibold text-white">
          {appName} is unavailable
        </h1>
        <p className="mt-2 text-sm text-white/60">
          This workspace isn't available right now. Please contact your
          administrator.
        </p>
        {import.meta.env.DEV && (
          <p className="mt-4 rounded-lg bg-white/5 p-3 text-left font-mono text-xs break-words text-amber-300/90">
            {reason}
          </p>
        )}
      </div>
    </div>
  )
}
