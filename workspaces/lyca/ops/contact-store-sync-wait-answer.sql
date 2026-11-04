-- HIR-526 go-live check 3: waits up to 100 s for pg_net's answer to the call made since __SINCE__
-- and fails unless every answer since then is HTTP 200. pg_net gives up after 90 s (the job's
-- timeout_milliseconds), so a slow run shows up here as "timed out: true", not as a missing answer.
-- __SINCE__ comes from env LYCA_SQL_SINCE: a UTC time a few seconds before the test call, e.g.
-- 2026-11-04T09:00:00Z. Holds no secret. (By hand in the SQL editor: replace __SINCE__ yourself.)
do $wait$
declare
  r record;
begin
  for i in 1..100 loop
    select count(*) as n,
           count(*) filter (where status_code = 200) as ok,
           max(status_code) filter (where status_code is distinct from 200) as bad_status,
           coalesce(bool_or(timed_out), false) as timed_out,
           max(error_msg) as error_msg
      into r
      from net._http_response
     where created >= timestamptz '__SINCE__';
    exit when r.n > 0;
    perform pg_sleep(1);
  end loop;
  if r.n = 0 then
    raise exception 'contact-store-sync: no answer within 100 s';
  end if;
  if r.ok < r.n then
    raise exception 'contact-store-sync answered HTTP % (timed out: %, error: %)',
      coalesce(r.bad_status::text, 'none'), r.timed_out, coalesce(r.error_msg, '-');
  end if;
  raise notice 'contact-store-sync answered HTTP 200 through Vault and pg_net';
end
$wait$;
