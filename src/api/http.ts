import axios from 'axios'
import { supabase } from '@/supabase/client'

/**
 * Configured Axios instance for any future REST/Edge Function calls that sit
 * outside the Supabase JS SDK. Automatically attaches the current user's
 * access token so custom endpoints can validate the caller.
 */
export const http = axios.create({
  baseURL: import.meta.env.VITE_SUPABASE_URL
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
    : undefined,
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
