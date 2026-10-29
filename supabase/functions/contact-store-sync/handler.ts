// contact-store-sync's request handling, kept apart from Deno.serve so it can
// be tested. See index.ts for what the function is for.

import {
  contactStoreConfigured,
  contactStoreReady,
} from '../candidate-contacts/contact-store.ts'
import {
  runSync,
  SyncDbError,
  type SyncDb,
  type SyncOptions,
} from '../candidate-contacts/store-sync.ts'

/** The header the scheduler sends the secret in. */
export const SECRET_HEADER = 'x-contact-store-sync-secret'
/** A shorter CONTACT_STORE_SYNC_SECRET counts as unset: every call is refused. */
export const MIN_SECRET_LENGTH = 32
/** How long GET /ready may take. */
const READY_TIMEOUT_MS = 5_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  )
}

/**
 * Constant-time comparison: both sides are hashed to the same length first,
 * then every byte is compared, so the time taken says nothing about how much
 * of the secret was right (or how long it is).
 */
export async function sameSecret(
  given: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export interface HandlerDeps {
  /** The secret as configured (Deno.env CONTACT_STORE_SYNC_SECRET in index.ts). */
  secret: string | undefined
  /** Lyca's database; only opened for an authorised call with a ready store. */
  db: () => SyncDb
  options?: SyncOptions
}

export async function handleSync(
  req: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const secret = deps.secret?.trim() ?? ''
  // Not set up on this project (e.g. Adobe's, which shares the functions): refuse everything.
  if (secret.length < MIN_SECRET_LENGTH) {
    return json({ error: 'Not configured' }, 503)
  }
  const given = req.headers.get(SECRET_HEADER) ?? ''
  if (!(await sameSecret(given, secret))) {
    return json({ error: 'Unauthorized' }, 401)
  }
  await req.body?.cancel()

  if (!contactStoreConfigured()) {
    return json({ status: 'skipped', reason: 'store_not_configured' })
  }
  if (!(await contactStoreReady(READY_TIMEOUT_MS))) {
    console.warn('contact store sync skipped: the store is not ready')
    return json({ status: 'skipped', reason: 'store_not_ready' })
  }
  try {
    const counts = await runSync(deps.db(), deps.options)
    console.log(`contact store sync: ${JSON.stringify(counts)}`)
    return json(counts)
  } catch (err) {
    // Only a code-level message: never a row's content.
    const message =
      err instanceof SyncDbError
        ? err.message
        : err instanceof Error
          ? err.name
          : 'error'
    console.error('contact store sync failed:', message)
    return json({ error: 'Sync failed' }, 500)
  }
}
