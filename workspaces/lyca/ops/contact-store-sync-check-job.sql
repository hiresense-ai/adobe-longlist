-- HIR-526 go-live check 1: fails unless an active contact-store-sync cron job exists, running
-- every 10 minutes, whose command sets pg_net's timeout. Holds no secret.
do $check$
declare
  v_job record;
begin
  select schedule, command into v_job
    from cron.job
   where jobname = 'contact-store-sync' and active;
  if not found then
    raise exception 'no active contact-store-sync cron job';
  end if;
  if v_job.schedule <> '*/10 * * * *' then
    raise exception 'contact-store-sync runs on %, not every 10 minutes', v_job.schedule;
  end if;
  if position('timeout_milliseconds' in v_job.command) = 0 then
    raise exception 'contact-store-sync cron command has no timeout_milliseconds (pg_net would give up after 5 s)';
  end if;
  raise notice 'contact-store-sync cron job is active, every 10 minutes';
end
$check$;
