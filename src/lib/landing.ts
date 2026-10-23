import { ROUTES } from '@/constants'
import { WORKSPACE } from '@/config/workspaces'

/** Where sign-in (and an already-signed-in visit to /login) should send the
 * user. Only workspaces that land on JD Analytics go through ROUTES.start
 * (LandingRedirect), which picks by role; everyone else goes straight to
 * Dashboards, exactly as before. */
export function landingRoute(): string {
  return WORKSPACE.landOnJdAnalytics ? ROUTES.start : ROUTES.home
}
