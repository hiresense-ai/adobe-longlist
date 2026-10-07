import type { Workspace } from '@/config/workspaces'

// Workspace branding applied to the document: tab title, favicon, and the
// theme's primary color. Purely cosmetic. Adobe's workspace applies nothing
// new — its title and favicon are index.html's own and its colors are the
// stylesheet defaults (src/index.css), so Adobe renders exactly as before.

// Every theme token that carries the brand hue (see src/index.css).
const PRIMARY_TOKENS = ['--primary', '--chart-1', '--sidebar-primary'] as const
const RING_TOKENS = ['--ring', '--sidebar-ring'] as const

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}

function primaryRules(selector: string, color: string) {
  const ring = `color-mix(in oklab, ${color} 50%, transparent)`
  return `${selector} {${[
    ...PRIMARY_TOKENS.map((token) => `${token}: ${color};`),
    ...RING_TOKENS.map((token) => `${token}: ${ring};`),
  ].join(' ')}}`
}

function setPrimaryColors(light: string | null, dark: string | null) {
  const id = 'workspace-brand-colors'
  document.getElementById(id)?.remove()
  // CSS.supports rejects anything that isn't a real color, so a bad config
  // value can never inject other CSS.
  const valid = (c: string | null) => (c && CSS.supports('color', c) ? c : null)
  const lightColor = valid(light)
  if (!lightColor) return
  const darkColor = valid(dark) ?? lightColor
  const style = document.createElement('style')
  style.id = id
  // Same specificity as src/index.css's :root / .dark rules, appended after
  // it, so these win in both themes.
  style.textContent =
    primaryRules(':root', lightColor) + primaryRules('.dark', darkColor)
  document.head.appendChild(style)
}

export function applyWorkspaceBranding(workspace: Workspace) {
  const { appName, faviconUrl, primaryColor, primaryColorDark } =
    workspace.branding
  if (document.title !== appName) document.title = appName
  setFavicon(faviconUrl)
  setPrimaryColors(primaryColor, primaryColorDark)
}
