# Contact reveal (Lyca)

How Lyca finds a candidate's email and phone, what it keeps, and how it stays in step with the shared contact store. Lyca only: Adobe's project shares the code but has none of these tables or settings.

The code is in `supabase/functions/candidate-contacts/`, with the flow decisions in `flow.ts`. The catch-up job is `supabase/functions/contact-store-sync/`.

## The reveal

**Who can do what:**
- "Get contact" is for Admins and Super Admins only, because it can spend vendor credits.
- Anyone who can see a dashboard can read its contacts and give a 👍/👎.

**A lookup only runs for a LinkedIn profile in that dashboard's own file.** Each person is limited to 60 vendor calls per 10 minutes.

"Get contact" asks, in this order, and stops at the first source that has a value for each kind (email, phone):

1. **Lyca's own rows.** A person looked up before is never bought again. Only kinds that still have no usable value are searched again: first in the store if it was never really asked for this person (it was down at the time, or the lookup predates it), then with a vendor that never answered for that kind.
2. **The shared contact store** at `CONTACT_ENRICHMENT_URL` (the contact-enrichment service). It holds what any HireSense platform has already revealed. If it has nothing usable, it asks ZipLabs on demand.
   - Lyca waits up to `CONTACT_ENRICHMENT_TIMEOUT_MS` (8 s by default), because a first ZipLabs answer takes several seconds.
   - **Still fetching.** The store may answer `pending` for a kind (ZipLabs is still fetching it) with `retry_after_ms`. Lyca then pays no vendor for that kind yet: it waits that long (at most 5 s), asks the store once more, and only what is still missing then goes to the vendors.
   - If the store is down, slow or answers with an error, Lyca goes on to its vendors. That is recorded (a `contact_store` row with status `error`), so a later "Get contact" asks the store again.
3. **SalesQL**, automatically, for each kind the store did not have.
4. **BetterContact**, automatically, for each kind SalesQL did not find.
   - BetterContact answers later. The panel checks back (a free status check, never a new charge).

**A vendor value its own vendor calls bad does not count as found.** That means a SalesQL email with status "Invalid", or a phone with `is_valid: false`. BetterContact is asked for that kind. Such a value is shown, marked "invalid by the source", only while nothing better exists. It is never sent to the shared store (other products would read it as an ordinary contact).

**One paid call per person and vendor at a time.** Two recruiters, two tabs or a double click on the same person pay SalesQL once and BetterContact once:
- Before paying, the request claims the person and vendor in `candidate_contact_claims`, with an insert that does nothing if the row exists.
- The request that gets the row reads the saved answer again (someone may have just paid), pays, saves the answer, then deletes the row. While it runs it refreshes the row's `claimed_at` every 30 s, so a slow call is never mistaken for a dead one.
- The others wait (up to 30 s, less if the request's time is nearly up) and show the saved answer.
- A claim not refreshed for 3 minutes was left by a request that died, and is taken over. Each claim query gives up after 5 s.

**A paid answer is never silently lost.** If saving it fails, the save is retried once with the same answer. If that fails too, the answer is lost: the log says so as an error, with counts only (status, number of emails and phones). The claim is then kept, not deleted, so nobody pays that vendor again for that person for 3 minutes; the request answers "temporarily unavailable".

**A SalesQL call that timed out (20 s) may have been charged,** so it is not repeated for 3 minutes. A call that never reached SalesQL is retried on the next click.

**One deadline per request (about 55 s).** The store's answer, its `pending` wait and the waits for another request's claim each get only what is left. A paid call (SalesQL, or starting a BetterContact search) starts only with at least 25 s left, enough to finish and save it; otherwise it is left for the next click ("Try again" / "Find email"), never paid and then cut off. BetterContact's own wait for its answer is cut to what is left; a search still running is saved as pending and checked later for free.

**Outage is not "no contact".** If the store or a vendor failed and nothing usable came back, the panel says the lookup is temporarily unavailable and offers "Try again". It never shows a final "No email found" in that case. An unexpected failure answers the same generic "temporarily unavailable" text; the database's or vendor's own message stays in the function log.

Known gaps: a store outage, once recorded, keeps showing "temporarily unavailable" until someone clicks "Try again" (the list never calls the store). A BetterContact error that needs an admin (no credits, key rejected, phone search not in the plan) also shows "Try again" until that is fixed.

The dashboard only ever sees "Email" and "Phone", plus whether a value came from the store or from Lyca's own vendors. It is never told which vendor.

## 👍/👎 and "Find another"

**👍/👎 is offered on:**
- store values;
- SalesQL values, until BetterContact has been asked for that kind.

It is never offered on BetterContact values, because there is no vendor left to ask after them.

Clicking the same thumb again clears it **in Lyca only**. The shared store has no way to clear a verdict (its API takes only 👍 or 👎), so a 👍/👎 that already reached the store stays there: a 👎 that is undone still marks the value bad for every other product. Only a new verdict on the same value replaces it. A 👍/👎 cleared before it reached the store (store down) is never sent, because clearing deletes Lyca's row.

**"Find another email / number" is offered:**
- after a 👎 on a store value: the next vendor not yet asked for that kind (SalesQL, else BetterContact);
- after a 👎 on a SalesQL value: BetterContact, if not yet asked for that kind;
- as "Find email / number" for a kind with no value that a vendor never answered for, or that the store was never really asked for.

It is never offered after BetterContact. Each kind is bought from each vendor at most once per person.

"Find another", and resuming a person looked up before, **ask the store first** for the kinds wanted. A value the store has that is new for this person (not shown yet, not marked 👎) answers that kind without a paid vendor.

**One phone format for every comparison.** The rule is in `phone.ts`, exactly contact-enrichment's `docs/PHONE.md` (HireTap uses the same rule):
- India (+91) is the default country.
- `+91 98765 43210`, `098765 43210` and `9876543210` are one number.
- A result starting `+0` is not a phone, and a `+91` number is a phone only with 12 digits in all.
- **A value the rule refuses is not a phone at all** (for example SalesQL's `12345`, even with `is_valid: true`). It is not kept, not shown and not counted as found, so BetterContact is asked for a phone.

The comparisons that use it: de-duplication, "is this marked 👎", "is this new" for Find another, and which row a 👍/👎 belongs to. Rows keep the vendor's own text; only the comparisons use the shared format.

## What is saved where

| Where | What |
| --- | --- |
| `candidate_contact_lookups` (Lyca's Supabase) | One row per person and source (`contact_store`, `salesql`, `bettercontact`): the emails and phones found, status, which kinds were searched. Service role only, no browser access. |
| `candidate_contact_feedback` (Lyca's Supabase) | One current 👍/👎 (with reason) per value. Service role only. |
| `candidate_contact_claims` (Lyca's Supabase) | A paid vendor call in progress: at most one per person and vendor, normally empty. Service role only. |
| The shared contact store | Every value SalesQL or BetterContact found, and every 👍/👎, so no HireSense platform pays for the same contact twice. Stored encrypted by the contact-enrichment service. |

## Keeping the store in step (HIR-526)

- **The live send.** Right after a row is saved, candidate-contacts sends it to the store in the background, so a reveal never waits on the store.
- **The mark.** Each row has `store_synced_at`:
  - Every write sets it back to empty.
  - A send that lands sets it, but only if the row is unchanged since the send (same `id` and `updated_at`).
  - A failed send leaves it empty.
- **The catch-up job.** `contact-store-sync` runs every 10 minutes (a pg_cron job on the Lyca project). It sends what is still empty, oldest first, lookups before 👍/👎, at most 200 rows and about 50 s per run.
  - It does nothing while the store's `GET /ready` is not 200.
  - It returns counts only. Logs never hold an email, phone or LinkedIn URL.
  - Rows from the store itself, and rows with no values, are marked without being sent.
  - A 👍/👎 waits (without using one of the 200 rows) while its contact's own row is not in the store yet, for at most 24 h.
- **`given_at`.** Every 👍/👎, live or from the job, carries `given_at`: the time it was saved.
  - The store ignores a verdict older than the one it holds, and ignores the same verdict sent twice, so re-sends are harmless.
  - A store from before `given_at` refuses the field. The verdict is then sent once more without it.

## Settings (function secrets on the Lyca project)

| Name | What |
| --- | --- |
| `CONTACT_ENRICHMENT_URL` | The contact-enrichment service. Unset: the store is skipped and the vendors run as before. |
| `CONTACT_ENRICHMENT_API_KEY` | Lyca's key for that service. |
| `CONTACT_ENRICHMENT_TIMEOUT_MS` | How long a reveal waits for the store (default **8000**). Keep 8000 on Lyca prod before ZipLabs on demand goes live on the store. Background saves and 👍/👎 have their own 3 s timeout. |
| `CONTACT_STORE_SYNC_SECRET` | The catch-up job's own key: the cron job sends it as header `x-contact-store-sync-secret`. While unset, `contact-store-sync` refuses every call. The cron job reads it from Supabase Vault. |
| `SALESQL_API_KEY`, `BETTERCONTACT_API_KEY` | The vendors. Unset: that vendor is skipped. |
| `SALESQL_API_URL`, `BETTERCONTACT_API_URL` | Local tests against a fake vendor only. Never set them on a hosted project. |

A store answer of 401 or 403 means Lyca's key is wrong or revoked. It is logged as an error, not a warning.

Locally these go in `supabase/functions/.env`, which is gitignored. Never commit a value.

## Going live

Migrations and functions reach the Lyca project only through `scripts/lyca-deploy.mjs` (see [ENVIRONMENTS.md](ENVIRONMENTS.md)). It refuses:
- `functions-deploy` while Lyca has not applied every migration in the checkout. Code that writes `store_synced_at` before the column exists would pay a vendor and then fail to save the answer. (The functions also save without the column if they ever meet a database without it, with a warning in the logs; the guard is the first line.)
- `db-push`, `functions-deploy` and `db-query` on a checkout with uncommitted changes under `supabase/`, `workspaces/lyca/` or `scripts/`. It prints the commit it deploys.
- `db-query` for any file that is not committed, unchanged, and directly in `workspaces/lyca/ops/`, or whose sha256 is not confirmed with `LYCA_DB_QUERY_SHA256` (`node scripts/lyca-deploy.mjs ops-sha256` lists them, without touching any project).

**Always migrations before functions.** For example, `20261029000002_contact_lookup_claims.sql` must be applied before the `candidate-contacts` that uses the claims. Without the table, every paid lookup fails instead of paying. `functions-deploy` refuses until every migration is applied.

### The catch-up job (once)

The job needs a secret and a schedule that must not live in git. A person runs `scripts/lyca-store-sync-go-live.ps1` from a clean checkout of the merged `main`, logged in to the Supabase CLI with access to the Lyca project. The SQL it runs is in `workspaces/lyca/ops/` (reviewed like any other file; none of it holds a secret). It stops at the first failure and can be run again; a rerun makes a new secret and sets it in both places.

0. **Checkout.** Refuses uncommitted changes, prints branch and commit, and asks before going on if that is not `origin/main`. Prints the sha256 of each SQL file it will run and asks you to confirm them against the merged PR.
1. **Migrations.** A dry run, then `yes` to apply. Expect `20261029000001_contact_store_sync.sql`, and `20261029000002_contact_lookup_claims.sql` once HIR-528 is merged. Anything else: answer `no` and find out why.
2. **Deploys** `candidate-contacts` and `contact-store-sync` (refused if step 1 did not apply everything).
3. **Secret.** A new random `CONTACT_STORE_SYNC_SECRET`, set as a function secret through a temporary env file that is deleted right after (also on failure). Never printed.
4. **Schedule.** `contact-store-sync-schedule.sql`: the function URL and the secret go into Supabase Vault, and a pg_cron job calls the function every 10 minutes. The job reads both from Vault, so the secret is not in the job's text.
   - The secret reaches `lyca-deploy.mjs` as env `LYCA_SQL_SYNC_SECRET` only. It fills it into a copy of the SQL inside its own throw-away work directory (removed afterwards) and prints the CLI's output with the secret replaced by `[redacted]`, so an error that echoes the statement does not show it.
   - The job's `net.http_post` sets `timeout_milliseconds := 90000`. pg_net's default is 5 s and a run takes up to about 55 s, so without it every answer would be pg_net's timeout.
   - If this step fails through the CLI, run the script again with `-PasteSql`: the filled-in SQL goes to the clipboard for the Supabase SQL editor, and the clipboard is cleared after Enter. With Windows clipboard history (Win+V), delete that entry too.
5. **Checks** (each one fails the script):
   - `contact-store-sync-check-job.sql`: the job exists, is active, runs every 10 minutes, and sets a pg_net timeout;
   - `contact-store-sync-test-call.sql` then `contact-store-sync-wait-answer.sql`: the job's own command (URL and secret from Vault, sent by pg_net) answers HTTP 200 within 100 s;
   - one direct call prints the counts, e.g. `{"status":"ok","lookups":{"sent":12,...},"feedback":{"sent":3,...}}`.

**By hand (SQL editor), names only, never `decrypted_secret`:**

```sql
select jobname, schedule, active from cron.job where jobname = 'contact-store-sync';
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'contact-store-sync')
 order by start_time desc limit 5;
select created, status_code, timed_out, error_msg, left(content, 300) as content
  from net._http_response order by id desc limit 5;
select count(*) from candidate_contact_lookups  where store_synced_at is null;
select count(*) from candidate_contact_feedback where store_synced_at is null;
select name, updated_at from vault.secrets where name like 'contact_store_sync%';
```

**Reading an answer:** `sent` = rows the store now has; `settled` = rows with nothing to send; `waiting` = 👍/👎 held until their contact is in the store (at most 24 h); `rejected` / `dropped_values` = data the store refuses as invalid, dropped so it never blocks the queue; `more: true` = rows left for the next run; `skipped` / `store_not_ready` = the store is down, retried in 10 minutes; `skipped` / `store_not_configured` = `CONTACT_ENRICHMENT_URL` or `_API_KEY` unset; HTTP 401 = Vault and the function secret differ (run the script again); HTTP 503 = `CONTACT_STORE_SYNC_SECRET` unset.

**Undo:** `select cron.unschedule('contact-store-sync');` in the SQL editor. The column can stay; without the job, rows are still marked whenever the live send works.
