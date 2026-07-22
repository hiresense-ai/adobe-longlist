import { useMemo, useState } from 'react'
import { Search, ShieldX, UserPlus, Users as UsersIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { CreateUserDialog } from '@/components/admin/CreateUserDialog'
import { EditUserDialog } from '@/components/admin/EditUserDialog'
import { DeleteUserDialog } from '@/components/admin/DeleteUserDialog'
import { UserRowActions } from '@/components/admin/UserRowActions'
import { UsersBackground } from '@/components/admin/UsersBackground'
import { useAdminUsers } from '@/hooks/useAdminUsers'
import { useAuth } from '@/hooks/useAuth'
import { filterAdminUsers } from '@/services/adminUsers.service'
import { getErrorMessage } from '@/lib/errors'
import { getInitials } from '@/lib/format'
import { formatDate } from '@/utils/date'
import type { AdminUserRow } from '@/types'

export function AdminUsers() {
  const { user: currentUser } = useAuth()
  const { data: users, isLoading, isError, error, refetch } = useAdminUsers()
  const [query, setQuery] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<AdminUserRow | null>(null)
  const [deletingUser, setDeletingUser] = useState<AdminUserRow | null>(null)

  const filtered = useMemo(
    () => filterAdminUsers(users ?? [], query),
    [users, query],
  )

  const existingEmails = useMemo(
    () => (users ?? []).map((u) => u.email.toLowerCase()),
    [users],
  )

  return (
    <div className="relative">
      <UsersBackground />
      <div className="relative z-10 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-foreground text-2xl font-semibold">Users</h1>
            <p className="text-muted-foreground text-sm">
              Manage who can access the Adobe Longlist portal.
            </p>
          </div>
          <Button onClick={() => setIsCreateOpen(true)}>
            <UserPlus className="size-4" />
            Create user
          </Button>
        </div>

        <div className="relative mb-5 max-w-xs">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search users..."
            className="h-9 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {isLoading && (
          <div className="border-border bg-card space-y-3 rounded-2xl border p-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            title="Couldn't load users"
            description={getErrorMessage(
              error,
              'Please check your connection and try again.',
            )}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !isError && users && users.length === 0 && (
          <EmptyState
            icon={UsersIcon}
            title="No users yet"
            description="Create the first account to get started."
          />
        )}

        {!isLoading &&
          !isError &&
          users &&
          users.length > 0 &&
          filtered.length === 0 && (
            <EmptyState
              icon={ShieldX}
              title="No matches found"
              description={`Nothing matches "${query}".`}
            />
          )}

        {!isLoading && !isError && filtered.length > 0 && (
          <div className="border-border bg-card shadow-soft overflow-hidden rounded-2xl border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead>
                  <tr className="border-border bg-muted/50 border-b text-xs">
                    <th className="text-muted-foreground w-12 px-4 py-3 font-medium"></th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Name
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Email
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Role
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Created
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Last login
                    </th>
                    <th className="text-muted-foreground px-2 py-3 font-medium">
                      Status
                    </th>
                    <th className="w-12 px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {filtered.map((user) => (
                    <tr
                      key={user.id}
                      className="hover:bg-muted/40 transition-colors duration-150"
                    >
                      <td className="px-4 py-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                            {getInitials(user.name ?? user.email)}
                          </AvatarFallback>
                        </Avatar>
                      </td>
                      <td className="px-2 py-3 font-medium">
                        {user.name ?? (
                          <span className="text-muted-foreground italic">
                            Unnamed
                          </span>
                        )}
                      </td>
                      <td className="text-muted-foreground px-2 py-3">
                        {user.email}
                      </td>
                      <td className="px-2 py-3">
                        <Badge
                          variant="outline"
                          className={
                            user.role === 'admin'
                              ? 'border-primary/30 bg-primary/5 text-primary capitalize'
                              : 'capitalize'
                          }
                        >
                          {user.role}
                        </Badge>
                      </td>
                      <td className="text-muted-foreground px-2 py-3">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="text-muted-foreground px-2 py-3">
                        {user.lastSignInAt
                          ? formatDate(user.lastSignInAt)
                          : 'Never'}
                      </td>
                      <td className="px-2 py-3">
                        <Badge
                          variant="outline"
                          className={
                            user.disabled
                              ? 'border-destructive/30 bg-destructive/5 text-destructive'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                          }
                        >
                          {user.disabled ? 'Disabled' : 'Active'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <UserRowActions
                          user={user}
                          currentUserId={currentUser?.id}
                          onEdit={setEditingUser}
                          onDelete={setDeletingUser}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <CreateUserDialog
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          existingEmails={existingEmails}
        />
        <EditUserDialog
          user={editingUser}
          onOpenChange={(open) => !open && setEditingUser(null)}
        />
        <DeleteUserDialog
          user={deletingUser}
          onOpenChange={(open) => !open && setDeletingUser(null)}
        />
      </div>
    </div>
  )
}
