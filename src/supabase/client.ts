import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Define VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env.local file (see .env.example).',
  )
}

// ---------------------------------------------------------------------------
// Environment isolation guard.
//
// Local development must run against the LOCAL Supabase stack
// (`npm run local:start`), never against the live production project. The
// production URL is not a secret (it ships in every production bundle), so
// naming it here costs nothing — and refusing it in dev mode makes the
// failure loud instead of silently writing test data into production, e.g.
// after a `vercel env pull` overwrites .env.local with hosted credentials.
//
// Production builds (Vercel) run with import.meta.env.DEV === false, so this
// guard compiles out of the deployed app entirely.
// ---------------------------------------------------------------------------
const PRODUCTION_SUPABASE_URL = 'https://lomiqhcbjivdgophreiw.supabase.co'
const isLocalBackend = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(
  supabaseUrl,
)

if (import.meta.env.DEV && supabaseUrl === PRODUCTION_SUPABASE_URL) {
  throw new Error(
    'REFUSING TO START: local development is pointed at the PRODUCTION ' +
      'Supabase project. Point .env.local at the local stack instead ' +
      '(npm run local:start, then copy the API URL and anon key from ' +
      '`npm run local:status` — see docs/ENVIRONMENTS.md). Never develop ' +
      'against production.',
  )
}

if (import.meta.env.DEV) {
  console.info(
    `[adobe-longlist] Environment: ${isLocalBackend ? 'LOCAL' : 'REMOTE'} — Supabase: ${supabaseUrl}`,
  )
}

/** True when the app is talking to a Supabase stack on this machine. */
export const IS_LOCAL_BACKEND = isLocalBackend

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
