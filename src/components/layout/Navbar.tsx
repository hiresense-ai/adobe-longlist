import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import {
  LayoutDashboard,
  LogOut,
  Search,
  User as UserIcon,
  UsersRound,
} from 'lucide-react'
import { toast } from 'sonner'

import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ThemeToggle } from '@/components/common/ThemeToggle'
import { AdobeLogo } from '@/components/layout/AdobeLogo'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import { getInitials } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Navbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isHome = location.pathname === ROUTES.home
  const isAdmin = user?.role === 'admin'

  // Primary top-nav destinations, with their active-route matching. Purely
  // presentational — routing is unchanged; this only decides which pill
  // reads as "current". Dashboards covers both the list (/) and an open
  // dashboard (/dashboards/:id).
  const navItems = [
    {
      to: ROUTES.home,
      label: 'Dashboards',
      icon: LayoutDashboard,
      isActive:
        location.pathname === ROUTES.home ||
        location.pathname.startsWith('/dashboards'),
    },
    ...(isAdmin
      ? [
          {
            to: ROUTES.adminUsers,
            label: 'Users',
            icon: UsersRound,
            isActive: location.pathname.startsWith(ROUTES.adminUsers),
          },
        ]
      : []),
  ]

  async function handleLogout() {
    try {
      await logout()
      navigate(ROUTES.login, { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unable to sign out'))
    }
  }

  return (
    <header className="border-border bg-card/80 supports-backdrop-filter:bg-card/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="app-container flex h-16 items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to={ROUTES.home}
          aria-label="Talent Landscape Reports — go to dashboards"
          className="focus-visible:ring-ring focus-visible:ring-offset-background flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          <AdobeLogo className="size-7" />
          <span className="text-foreground hidden text-lg font-semibold tracking-tight sm:block">
            Talent Landscape Reports
          </span>
        </Link>

        <nav className="hidden items-center gap-1.5 md:flex">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={item.isActive ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-ring focus-visible:ring-offset-background flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  item.isActive
                    ? 'bg-primary text-primary-foreground shadow-primary/25 shadow-sm ring-1 ring-white/15 ring-inset'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground hover:-translate-y-px hover:shadow-sm',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex flex-1 items-center justify-end gap-3">
          {isHome && (
            <div className="relative w-full max-w-xs">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                type="search"
                placeholder="Search dashboards..."
                className="h-9 pl-9"
                value={searchParams.get('q') ?? ''}
                onChange={(event) => {
                  const next = new URLSearchParams(searchParams)
                  if (event.target.value) {
                    next.set('q', event.target.value)
                  } else {
                    next.delete('q')
                  }
                  setSearchParams(next, { replace: true })
                }}
              />
            </div>
          )}

          <ThemeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger className="ring-offset-background focus-visible:ring-ring flex items-center rounded-full outline-none focus-visible:ring-2">
              <Avatar className="size-9">
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                  {getInitials(user?.name ?? user?.email ?? '?')}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <p className="text-foreground truncate text-sm font-medium">
                  {user?.name ?? 'Unnamed user'}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {user?.email}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to={ROUTES.profile}>
                  <UserIcon className="size-4" />
                  Profile
                </Link>
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem asChild className="md:hidden">
                  <Link to={ROUTES.adminUsers}>
                    <UsersRound className="size-4" />
                    Users
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleLogout}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}
