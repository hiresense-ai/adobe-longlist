import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { LogOut, Search, User as UserIcon, Users } from 'lucide-react'
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
import { PoweredByHireSense } from '@/components/common/PoweredByHireSense'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES, APP_NAME } from '@/constants'
import { getErrorMessage } from '@/lib/errors'
import { getInitials } from '@/lib/format'

export function Navbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isHome = location.pathname === ROUTES.home
  const isAdmin = user?.role === 'admin'

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
        <Link to={ROUTES.home} className="flex shrink-0 items-center gap-2.5">
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg text-sm font-bold">
            A
          </span>
          <span className="hidden flex-col sm:flex">
            <span className="text-foreground text-base leading-tight font-semibold">
              {APP_NAME}
            </span>
            <PoweredByHireSense />
          </span>
        </Link>

        {isAdmin && (
          <Link
            to={ROUTES.adminUsers}
            className="text-muted-foreground hover:text-foreground hidden items-center gap-1.5 text-sm font-medium transition-colors md:flex"
          >
            <Users className="size-4" />
            Users
          </Link>
        )}

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
                    <Users className="size-4" />
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
