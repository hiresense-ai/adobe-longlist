-- Adobe Longlist — rename "Screen Select"/"Screen Reject" candidate actions
-- to "Screen Select - HireSense"/"Screen Reject - HireSense", matching the
-- existing "<action> - <org>" naming convention already used by every other
-- action ("Offer - Adobe" / "Offer - HireSense", "Interview stage - Adobe" /
-- "Interview stage - HireSense"). Product-owner-requested rename only — no
-- behavior change.
--
-- A true rename, not an add-alongside: existing dashboard_status rows using
-- the old values are updated in place, so no row is ever left holding a
-- value the app's actionConfig.ts (which no longer has an entry for the old
-- strings) doesn't recognize.
--
-- Ordering (this is the part that matters): the OLD constraint — still
-- active at the start of this migration — only allows the OLD bare values
-- ('Screen Select', 'Screen Reject'), not the new "- HireSense" strings.
-- Postgres validates every UPDATE against whichever constraint is active
-- AT THAT STATEMENT, not the one this migration is about to install — so
-- an UPDATE that writes the new value while the old constraint is still in
-- place fails immediately, before touching a single row. The old
-- constraint must be dropped (or relaxed) FIRST; only then can the data be
-- updated; only then can the final, tightened constraint be added.

alter table public.dashboard_status
  drop constraint if exists dashboard_status_action_check;

update public.dashboard_status
set action = 'Screen Select - HireSense'
where action = 'Screen Select';

update public.dashboard_status
set action = 'Screen Reject - HireSense'
where action = 'Screen Reject';

alter table public.dashboard_status
  add constraint dashboard_status_action_check check (
    action is null or action in (
      'Interview Reject - Adobe',
      'Reviewed earlier (SR) - Adobe',
      'Reviewed earlier (TR) - Adobe',
      'Interview stage - Adobe',
      'Interview stage - HireSense',
      'Offer - Adobe',
      'Offer - HireSense',
      'Screen Select - HireSense',
      'Screen Reject - HireSense'
    )
  );
