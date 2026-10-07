import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WORKSPACE } from '@/config/workspaces'
import { applyWorkspaceBranding } from '@/lib/branding'
import { WORKSPACE_CONFIG_ERROR } from '@/supabase/client'
import { WorkspaceUnavailable } from '@/pages/Workspace/WorkspaceUnavailable'

// Before first paint: this workspace's title/favicon/colors (a no-op for
// Adobe, whose are index.html's and the stylesheet's own).
applyWorkspaceBranding(WORKSPACE)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {WORKSPACE_CONFIG_ERROR ? (
      // Fail closed: no backend for this workspace, so no app at all.
      <WorkspaceUnavailable
        appName={WORKSPACE.branding.appName}
        reason={WORKSPACE_CONFIG_ERROR}
      />
    ) : (
      <App />
    )}
  </StrictMode>,
)
