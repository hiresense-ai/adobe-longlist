import { createBrowserRouter } from 'react-router-dom'

import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/auth/ProtectedRoute'
import { GuestRoute } from '@/components/auth/GuestRoute'
import { AdminRoute } from '@/components/auth/AdminRoute'
import { ForcePasswordChangeGate } from '@/components/auth/ForcePasswordChangeGate'
import { RouteErrorBoundary } from '@/components/common/RouteErrorBoundary'
import { NotFound } from '@/pages/NotFound'
import { ROUTES } from '@/constants'
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

export const router = createBrowserRouter([
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
              {
                element: <AdminRoute />,
                children: [
                  { path: ROUTES.adminUsers, element: <AdminUsers /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: ROUTES.notFound, element: <NotFound /> },
])
