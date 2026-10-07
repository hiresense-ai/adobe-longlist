import { AdobeLogo } from '@/components/layout/AdobeLogo'
import { WORKSPACE } from '@/config/workspaces'
import { cn } from '@/lib/utils'

/**
 * The page's workspace logo in the app header. Adobe keeps its original
 * inline mark (AdobeLogo — unchanged, sized by `className`). Other
 * workspaces use their configured image: wordmarks come in any width, so
 * they're sized by height and keep their own aspect ratio, with the dark
 * variant (e.g. a white wordmark) swapped in under the dark theme.
 */
export function WorkspaceLogo({ className }: { className?: string }) {
  const { logo, clientName } = WORKSPACE.branding
  if (!logo) return <AdobeLogo className={className} />

  const imageClass = 'h-7 w-auto max-w-[8rem] shrink-0 object-contain'
  if (!logo.darkSrc) {
    return <img src={logo.src} alt={clientName} className={imageClass} />
  }
  return (
    <>
      <img
        src={logo.src}
        alt={clientName}
        className={cn(imageClass, 'dark:hidden')}
      />
      <img
        src={logo.darkSrc}
        alt={clientName}
        className={cn(imageClass, 'hidden dark:block')}
      />
    </>
  )
}
