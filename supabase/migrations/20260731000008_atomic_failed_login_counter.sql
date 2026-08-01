-- Adobe Longlist — atomic failed-login counter.
--
-- Fixes a confirmed lockout bypass. auth-login previously did a
-- read-modify-write on profiles.failed_login_attempts:
--
--     const nextAttempts = profile.failed_login_attempts + 1   -- read (earlier)
--     ...update({ failed_login_attempts: nextAttempts })       -- write (later)
--
-- Concurrent requests all read the same starting value and then overwrite
-- each other, so N simultaneous wrong-password attempts increment the
-- counter by far less than N. Measured against the deployed function before
-- this migration: 5 simultaneous wrong passwords left the counter at 1 and
-- the account NOT locked. That is a complete bypass of the 3-strike lock —
-- an attacker who fires guesses in parallel instead of serially never trips
-- it, no matter how many they make.
--
-- The fix is to do the increment and the lock decision in ONE statement,
-- server-side, so Postgres' row lock serializes concurrent callers and each
-- one reads the previous one's committed value.
--
-- Additive: no column added, dropped, or rewritten; no existing row touched.
-- Only a new function. auth-login is updated to call it instead of computing
-- the next value itself.

-- ---------------------------------------------------------------------------
-- register_failed_login()
--
-- Increments the counter by exactly one and, if that crosses the threshold
-- (and this account is allowed to lock — super_admin never is), stamps the
-- lock in the same statement.
--
-- p_lock_duration_ms is supplied by the caller rather than computed here on
-- purpose: the random 10-20 minute duration lives in one place
-- (_shared/lockout.ts randomLockDurationMs), shared by every caller, instead
-- of being reimplemented in SQL where it could drift.
--
-- Returns the POST-increment state, plus just_locked so the caller knows
-- whether this specific call is the one that locked the account and should
-- therefore write the account.locked audit entry. Without that flag a
-- concurrent burst could write several duplicate lock entries for one lock.
-- ---------------------------------------------------------------------------
create or replace function public.register_failed_login(
  p_user_id uuid,
  p_max_attempts integer,
  p_lock_duration_ms integer,
  p_can_lock boolean
)
returns table (
  out_attempts integer,
  out_locked_at timestamptz,
  out_lock_expires_at timestamptz,
  out_just_locked boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_locked boolean;
begin
  -- Take the row lock first. Every concurrent caller queues here, so the
  -- UPDATE below always reads the previous caller's committed value rather
  -- than a stale snapshot — this is what makes the increment atomic.
  select (p.locked_at is not null)
    into v_was_locked
    from public.profiles p
   where p.id = p_user_id
     for update;

  -- No such profile: return an empty result set. The caller already handles
  -- the unknown-account case separately and must not treat this as a lock.
  if not found then
    return;
  end if;

  return query
  update public.profiles p
     set failed_login_attempts = p.failed_login_attempts + 1,
         last_failed_login_at  = now(),
         -- Only stamp a lock on the transition into it: `p.locked_at is
         -- null` keeps an already-locked account's original lock time and
         -- expiry intact rather than sliding the window forward on every
         -- further attempt.
         locked_at = case
           when p_can_lock
            and p.failed_login_attempts + 1 >= p_max_attempts
            and p.locked_at is null
           then now()
           else p.locked_at
         end,
         lock_expires_at = case
           when p_can_lock
            and p.failed_login_attempts + 1 >= p_max_attempts
            and p.locked_at is null
           then now() + (p_lock_duration_ms * interval '1 millisecond')
           else p.lock_expires_at
         end
   where p.id = p_user_id
  returning
    p.failed_login_attempts,
    p.locked_at,
    p.lock_expires_at,
    (p.locked_at is not null and not v_was_locked);
end;
$$;

comment on function public.register_failed_login(uuid, integer, integer, boolean) is
  'Atomically increments profiles.failed_login_attempts and applies the lockout in a single statement. Replaces auth-login''s previous read-modify-write, which lost concurrent increments and allowed the 3-strike lock to be bypassed by firing guesses in parallel. Service-role only.';

-- Callable only by the service role (the auth-login Edge Function). Revoked
-- from anon/authenticated so it can't be driven directly from a browser to
-- inflate someone else's counter as a denial-of-service.
--
-- Note this is defence in depth, not the only barrier: the pre-existing
-- guard_profile_lock_columns() trigger already reverts writes to these
-- columns whenever auth.uid() is non-null, which is the case for any
-- browser-originated call regardless of this grant.
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from public;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from anon;
revoke all on function public.register_failed_login(uuid, integer, integer, boolean) from authenticated;
grant execute on function public.register_failed_login(uuid, integer, integer, boolean) to service_role;
