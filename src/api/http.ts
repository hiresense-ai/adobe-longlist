import axios from 'axios'
import { supabase, SUPABASE_URL } from '@/supabase/client'

/**
 * Configured Axios instance for any future REST/Edge Function calls that sit
 * outside the Supabase JS SDK. Automatically attaches the current user's
 * access token so custom endpoints can validate the caller.
 */
// Always this page's workspace project (never a hard-coded env var), so a
// Lyca page can't reach Adobe's functions through this either.
export const http = axios.create({
  baseURL: SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : undefined,
  timeout: 15_000,
})

http.interceptors.request.use(async (config) => {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }

  return config
})
