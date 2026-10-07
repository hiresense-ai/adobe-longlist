/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Adobe (the default workspace) — unchanged.
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  // Lyca Mobile — its own, separate Supabase project. Optional: when absent
  // the /lyca workspace fails closed (src/supabase/workspaceConfig.ts).
  readonly VITE_LYCA_SUPABASE_URL?: string
  readonly VITE_LYCA_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
