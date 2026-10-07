import adobeLoginHero from '@/assets/login-hero-bg.jpg'

/**
 * Client workspaces. Adobe and Lyca Mobile are PHYSICALLY SEPARATE Supabase
 * projects — each with its own database, Auth, Storage and Edge Functions.
 * This one app serves both: a page load picks its workspace ONCE, from the
 * URL it was loaded at (/lyca/... is Lyca; everything else is Adobe, whose
 * URLs are unchanged), and from then on talks only to that workspace's
 * project (see src/supabase/client.ts). Moving between workspaces is always
 * a full page load, so no client, session, cache or state ever carries over.
 *
 * Everything here is presentation/routing configuration. The isolation
 * itself comes from the separate projects: a Lyca page holds no Adobe
 * credentials at all, and each project only accepts its own tokens.
 */
export type WorkspaceId = 'adobe' | 'lyca'

export interface WorkspaceBranding {
  /** The client ("Adobe", "Lyca Mobile"). */
  clientName: string
  /** Product name for titles and headings ("Adobe Longlist"). */
  appName: string
  /**
   * Header logo. `null` = the built-in Adobe mark (AdobeLogo). Otherwise an
   * image, plus an optional variant for dark backgrounds.
   */
  logo: { src: string; darkSrc: string | null } | null
  faviconUrl: string
  /** Sign-in hero artwork (logo, headline and tagline baked in). */
  loginHeroUrl: string
  /**
   * Overrides the theme's primary color (src/index.css). null keeps the
   * stylesheet default — Adobe's original red.
   */
  primaryColor: string | null
  /** Primary for dark mode (null: same as primaryColor). */
  primaryColorDark: string | null
  /** Example text in inputs that would otherwise name another client. */
  placeholders: {
    signInEmail: string
    newUserEmail: string
    requirementTitle: string
  }
}

export interface Workspace {
  id: WorkspaceId
  /** Router basename. '' = the site root (Adobe's original URLs). */
  basePath: string
  branding: WorkspaceBranding
  /**
   * The shared candidate-action VALUES name the client ("Interview stage -
   * Adobe"); they're identical in every project so the same code, database
   * constraint and analytics work everywhere. This is only how that client
   * part READS in this workspace's UI — see actionLabel().
   */
  actionClientLabel: string
  /**
   * supabase-js auth storage key. `undefined` = the library default, so
   * Adobe's existing browser sessions keep working untouched; every other
   * workspace has its own key, so the two sessions never share storage.
   */
  authStorageKey: string | undefined
}

export const WORKSPACES: Record<WorkspaceId, Workspace> = {
  adobe: {
    id: 'adobe',
    basePath: '',
    branding: {
      clientName: 'Adobe',
      appName: 'Adobe Longlist',
      logo: null,
      faviconUrl: '/favicon.svg',
      loginHeroUrl: adobeLoginHero,
      primaryColor: null,
      primaryColorDark: null,
      placeholders: {
        signInEmail: 'you@adobe.com',
        newUserEmail: 'jane.doe@adobe.com',
        requirementTitle: 'e.g. Adobe AEM Architect',
      },
    },
    actionClientLabel: 'Adobe',
    authStorageKey: undefined,
  },
  lyca: {
    id: 'lyca',
    basePath: '/lyca',
    branding: {
      clientName: 'Lyca Mobile',
      appName: 'Lyca Mobile Longlist',
      logo: {
        src: '/branding/lyca/logo.webp',
        darkSrc: '/branding/lyca/logo-light.webp',
      },
      faviconUrl: '/branding/lyca/favicon.png',
      loginHeroUrl: '/branding/lyca/login-hero.jpg',
      // Lyca blue (the brand's call-to-action color); slightly lighter on
      // dark backgrounds for contrast.
      primaryColor: '#006ae0',
      primaryColorDark: '#3d8ef0',
      placeholders: {
        signInEmail: 'you@company.com',
        newUserEmail: 'jane.doe@company.com',
        requirementTitle: 'e.g. Senior Data Engineer',
      },
    },
    actionClientLabel: 'Lyca',
    authStorageKey: 'sb-longlist-lyca-auth-token',
  },
}

const LYCA_PATH = /^\/lyca(?:\/|$)/i

export function workspaceForPath(pathname: string): Workspace {
  return LYCA_PATH.test(pathname) ? WORKSPACES.lyca : WORKSPACES.adobe
}

/** This page load's workspace — fixed for the lifetime of the page. */
export const WORKSPACE: Workspace = workspaceForPath(window.location.pathname)
