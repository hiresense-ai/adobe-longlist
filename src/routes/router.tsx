import { createBrowserRouter, type RouteObject } from 'react-router-dom'

import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/auth/ProtectedRoute'
import { GuestRoute } from '@/components/auth/GuestRoute'
import { AdminRoute } from '@/components/auth/AdminRoute'
import { SuperAdminRoute } from '@/components/auth/SuperAdminRoute'
import { ForcePasswordChangeGate } from '@/components/auth/ForcePasswordChangeGate'
import { RouteErrorBoundary } from '@/components/common/RouteErrorBoundary'
import { NotFound } from '@/pages/NotFound'
import { ROUTES } from '@/constants'
import { WORKSPACE } from '@/config/workspaces'
import { lazyNamed } from '@/lib/lazyNamed'

const Login = lazyNamed(() => import('@/pages/Login'), 'Login')
const ForgotPassword = lazyNamed(
  () => import('@/pages/Login'),
  'ForgotPassword',
)
const Dashboard = lazyNamed(() => import('@/pages/Dashboard'), 'Dashboard')
const DashboardViewer = lazyNamed(
  () => import('@/pages/DashboardViewer'),
  'DashboardViewer',
)
const Profile = lazyNamed(() => import('@/pages/Profile'), 'Profile')
const AdminUsers = lazyNamed(() => import('@/pages/AdminUsers'), 'AdminUsers')
const Requirements = lazyNamed(
  () => import('@/pages/Requirements'),
  'Requirements',
)
const JdAnalytics = lazyNamed(
  () => import('@/pages/JdAnalytics'),
  'JdAnalytics',
)
const ActionLogs = lazyNamed(() => import('@/pages/ActionLogs'), 'ActionLogs')
const WorkspaceNotFound = lazyNamed(
  () => import('@/pages/Workspace'),
  'WorkspaceNotFound',
)

// A sign-in link for a workspace that doesn't exist (/unknown/login) gets
// an explicit "workspace not found" — never Adobe's sign-in page. Only the
// root (Adobe) router needs this: every /lyca/... URL is served by the Lyca
// router, whose own unmatched paths fall through to NotFound as before.
const unknownWorkspaceRoutes: RouteObject[] =
  WORKSPACE.basePath === ''
    ? [
        { path: ROUTES.unknownWorkspaceLogin, element: <WorkspaceNotFound /> },
        {
          path: ROUTES.unknownWorkspaceForgotPassword,
          element: <WorkspaceNotFound />,
        },
      ]
    : []

const routes: RouteObject[] = [
  {
    element: <GuestRoute />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: ROUTES.login, element: <Login /> },
      { path: ROUTES.forgotPassword, element: <ForgotPassword /> },
    ],
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        // Sits between the session check and the app shell: a user whose
        // password an admin reset gets the change-password screen for every
        // path, with no navbar and no route to slip past it.
        element: <ForcePasswordChangeGate />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { path: ROUTES.home, element: <Dashboard /> },
              { path: ROUTES.dashboardPattern, element: <DashboardViewer /> },
              { path: ROUTES.profile, element: <Profile /> },
              // Every authenticated role: creation is open to all, and the
              // requirements Edge Function decides per-role what each
              // caller can see or do once inside.
              { path: ROUTES.requirements, element: <Requirements /> },
              {
                // Admin and Super Admin only. AdminRoute is the existing
                // role gate (isAtLeastAdmin) — the same rule as
                // canViewJdAnalytics, which hides the nav entry; the
                // dashboard-analytics Edge Function refuses a Viewer's
                // overview call server-side regardless of the UI.
                element: <AdminRoute />,
                children: [
                  { path: ROUTES.adminUsers, element: <AdminUsers /> },
                  { path: ROUTES.jdAnalytics, element: <JdAnalytics /> },
                ],
              },
              {
                // Super Admin only — narrower than AdminRoute above.
                // canViewActionLogs hides the nav entry the same way; the
                // action-logs Edge Function refuses an Admin's or Viewer's
                // call server-side regardless of this route guard (that
                // table has no client-reachable RLS policy at all).
                element: <SuperAdminRoute />,
                children: [
                  { path: ROUTES.actionLogs, element: <ActionLogs /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  ...unknownWorkspaceRoutes,
  { path: ROUTES.notFound, element: <NotFound /> },
]

// The workspace's basePath is the router's basename: '' for Adobe (its
// original URLs, unchanged) and '/lyca' for Lyca Mobile, so
// ROUTES.dashboard(id) is /dashboards/<id> on an Adobe page and
// /lyca/dashboards/<id> on a Lyca page — every link, redirect and navigate()
// stays inside the page's own workspace.
export const router = createBrowserRouter(routes, {
  basename: WORKSPACE.basePath || undefined,
})
