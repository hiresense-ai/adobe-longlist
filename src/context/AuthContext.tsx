import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/supabase/client'
import { getProfile } from '@/supabase/database'
import { signInWithPassword, signOut as signOutRequest } from '@/supabase/auth'
import type { AppUser } from '@/types'
import { AuthContext } from './auth-context'

async function buildAppUser(session: Session | null): Promise<AppUser | null> {
  if (!session?.user) return null

  const profile = await getProfile(session.user.id)

  return {
    id: session.user.id,
    email: session.user.email ?? '',
    name: profile?.name ?? null,
    role: profile?.role ?? 'viewer',
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<AppUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let isMounted = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!isMounted) return
      setSession(data.session)
      setUser(await buildAppUser(data.session))
      setIsLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!isMounted) return
      setSession(nextSession)
      setUser(await buildAppUser(nextSession))
      setIsLoading(false)
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  async function login(email: string, password: string) {
    await signInWithPassword(email, password)
  }

  async function logout() {
    await signOutRequest()
  }

  return (
    <AuthContext.Provider value={{ session, user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
