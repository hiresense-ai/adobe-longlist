import { useEffect } from 'react'
import { Building2 } from 'lucide-react'

/**
 * /<unknown>/login and /<unknown>/forgot-password: a sign-in link for a
 * workspace that doesn't exist. Deliberately neutral — never Adobe's (or
 * any other client's) sign-in page, so a mistyped link can't land someone
 * on the wrong client's login.
 */
export function WorkspaceNotFound() {
  useEffect(() => {
    const previous = document.title
    document.title = 'Workspace not found'
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div className="flex min-h-svh items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/10 text-white/70">
          <Building2 className="size-6" />
        </div>
        <p className="text-sm font-medium tracking-wide text-white/40">404</p>
        <h1 className="mt-1 text-lg font-semibold text-white">
          Workspace not found
        </h1>
        <p className="mt-2 text-sm text-white/60">
          This sign-in link doesn't match any workspace. Please use the sign-in
          link your administrator gave you.
        </p>
      </div>
    </div>
  )
}
