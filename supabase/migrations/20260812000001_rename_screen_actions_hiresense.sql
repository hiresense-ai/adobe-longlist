-- Adobe Longlist — rename "Screen Select"/"Screen Reject" candidate actions
-- to "Screen Select - HireSense"/"Screen Reject - HireSense", matching the
-- existing "<action> - <org>" naming convention already used by every other
-- action ("Offer - Adobe" / "Offer - HireSense", "Interview stage - Adobe" /
-- "Interview stage - HireSense"). Product-owner-requested rename only — no
-- behavior change.
--
-- A true rename, not an add-alongside: existing dashboard_status rows using
-- the old values are updated in place BEFORE the CHECK constraint is
-- tightened, so no row is ever left holding a value the constraint (or the
-- app's actionConfig.ts, which no longer has an entry for the old strings)
-- doesn't recognize. Order matters — updating data first means the second
-- ALTER TABLE's implicit revalidation of every row always passes.

update public.dashboard_status
set action = 'Screen Select - HireSense'
where action = 'Screen Select';

update public.dashboard_status
set action = 'Screen Reject - HireSense'
where action = 'Screen Reject';

alter table public.dashboard_status
  drop constraint if exists dashboard_status_action_check;

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
