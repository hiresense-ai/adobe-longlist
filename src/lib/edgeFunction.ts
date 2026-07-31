import { supabase } from '@/supabase/client'

/**
 * Invokes a Supabase Edge Function and unwraps its `{ error }` payload into
 * a real thrown Error, so callers can just try/catch and read error.message
 * like every other failure path in this app. Supabase wraps a non-2xx
 * response in a FunctionsHttpError whose own .message is a generic "non-2xx
 * status code" string; the actual `{ error: string }` body sent by the
 * function lives on error.context (a Response), not on the error itself.
 */
export async function invokeEdgeFunction<T>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
  })

  if (error) {
    const context = (error as { context?: Response }).context
    let parsed: { error?: string; locked?: boolean } | null = null
    if (context) {
      try {
        parsed = await context.clone().json()
      } catch {
        // Body wasn't JSON — fall through to the generic error below.
      }
    }
    if (parsed?.error) {
      // `locked` rides along on auth-login's response only — false (and
      // unused) for every other function.
      throw Object.assign(new Error(parsed.error), {
        locked: Boolean(parsed.locked),
      })
    }
    throw new Error(error.message)
  }

  return data as T
}
