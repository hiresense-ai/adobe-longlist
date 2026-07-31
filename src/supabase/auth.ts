import { supabase } from './client'
import { invokeEdgeFunction } from '@/lib/edgeFunction'

interface LoginResponse {
  access_token: string
  refresh_token: string
}

/**
 * Routed through the auth-login Edge Function rather than calling
 * supabase.auth.signInWithPassword() directly — GoTrue has no notion of this
 * app's account lockout, so a direct client-side call would bypass it
 * entirely (a locked account could still sign in with the right password).
 * The function does the real credential check itself and, on success, hands
 * back a session for this client to adopt via setSession() — from here on,
 * onAuthStateChange fires exactly as it would have for a direct sign-in.
 */
export async function signInWithPassword(email: string, password: string) {
  const { access_token, refresh_token } =
    await invokeEdgeFunction<LoginResponse>('auth-login', { email, password })

  const { data, error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function sendPasswordResetEmail(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  })
  if (error) throw error
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session
}
