-- HIR-526: call the contact-store-sync Edge Function every 10 minutes (pg_cron + pg_net).
-- Lyca project only. Run by scripts/lyca-store-sync-go-live.ps1 through
--   node scripts/lyca-deploy.mjs db-query contact-store-sync-schedule.sql
-- which fills __FUNCTION_URL__ from env LYCA_SQL_FUNCTION_URL and __SYNC_SECRET__ from env
-- LYCA_SQL_SYNC_SECRET in a copy that exists only in its throw-away work directory, and prints
-- the CLI's output with both values replaced by [redacted]. Never save a filled-in copy.
--
-- The secret and the URL go into Supabase Vault; the cron command reads them from
-- vault.decrypted_secrets each time it runs, so neither appears in cron.job's command text.
-- Safe to run again: the Vault entries are updated in place and cron.schedule replaces the job
-- of the same name. One single statement (a DO block), because `supabase db query` runs one
-- statement per call.
--
-- timeout_milliseconds: pg_net gives up after 5 s by default. A sync run takes up to about 55 s
-- (50 s budget, each store call cut to what is left, plus start-up), so 90 s: the answer recorded
-- in net._http_response is then the function's own, not pg_net's timeout.
do $setup$
declare
  v_id uuid;
begin
  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;

  select id into v_id from vault.secrets where name = 'contact_store_sync_url';
  if v_id is null then
    perform vault.create_secret('__FUNCTION_URL__', 'contact_store_sync_url',
      'HIR-526: URL of the contact-store-sync Edge Function (called by the contact-store-sync cron job)');
  else
    perform vault.update_secret(v_id, '__FUNCTION_URL__');
  end if;

  v_id := null;
  select id into v_id from vault.secrets where name = 'contact_store_sync_secret';
  if v_id is null then
    perform vault.create_secret('__SYNC_SECRET__', 'contact_store_sync_secret',
      'HIR-526: CONTACT_STORE_SYNC_SECRET, sent as header x-contact-store-sync-secret by the cron job');
  else
    perform vault.update_secret(v_id, '__SYNC_SECRET__');
  end if;

  perform cron.schedule(
    'contact-store-sync',
    '*/10 * * * *',
    $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'contact_store_sync_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-contact-store-sync-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'contact_store_sync_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 90000
    );
    $job$
  );
end
$setup$;
