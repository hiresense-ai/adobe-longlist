import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { AppUser } from '@/types'

export interface AuthContextValue {
  session: Session | null
  user: AppUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-reads the profile behind the current session. Used after a
   * self-service password change so forcePasswordChange clears without
   * making the user sign in again. */
  refreshUser: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
)
