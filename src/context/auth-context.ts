import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { AppUser } from '@/types'

export interface AuthContextValue {
  session: Session | null
  user: AppUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
)
