-- HIR-526 go-live check 2: runs the cron job's own command once (net.http_post with the URL and
-- secret read from Vault). pg_net sends it after this commits; contact-store-sync-wait-answer.sql
-- reads the answer. Holds no secret.
do $call$
declare
  v_command text;
begin
  select command into v_command
    from cron.job
   where jobname = 'contact-store-sync' and active;
  if v_command is null then
    raise exception 'no active contact-store-sync cron job';
  end if;
  execute v_command;
end
$call$;
