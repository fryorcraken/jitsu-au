# Simplify memberships: casual class vs membership per window, plus a manager dashboard

The pre-launch membership UX is too complicated: a "period basis" dropdown,
a "duration (days)" field on the plan editor, and a whole separate "semesters"
screen layered over the membership plan. Because nothing is live and existing
data is test data, this redesign may be destructive.

## Product model (what people see)

- A member chooses between **Casual class** (pay per session) and **Membership**
  (unlimited classes for a window of dates the club sets, e.g. 20 Jul – 16 Dec).
  The membership card offers the current window and, once defined, the next one.
- **Yearly insurance** stays, and becomes effectively mandatory when buying
  anything. On the membership screen it is **pre-selected only when the member
  has no current insurance, or theirs expires within 30 days**. It can be
  deselected only if the member already holds an ongoing yearly insurance.
  Enforced server-side too: no paid plan purchase without insurance cover.
- Managers get a **dashboard as their default landing screen** (`/manager`),
  with a **notifications** section. The first notification type: the latest
  membership window ends within 30 days and no next window is defined
  ("set the next membership window").
- Managers edit membership windows on the **plans page** itself (folded in from
  the deleted separate screen). `duration (days)` and `period basis` go away.
- The pricing page shows the membership window dates as before.

"1 month" means **30 days**, everywhere.

## User-facing behavior

- `/membership` shows: your status, then Casual class card, Membership card
  (with current/next window radio options, dates shown), and the yearly
  insurance as a checkbox addon with a price and clear reason text when forced.
- Choosing membership buys the plan; if insurance is required/preselected and
  left on, one bank-transfer reference covers the combined total.
- Bank reconciliation activates every pending invoice that shares the matched
  reference when a transfer covers the combined amount.
- `/manager` dashboard: "Needs attention" notifications + quick links to the
  manager areas. Managers land here after password sign-in.
- `/manager/membership-plans` edits plans (name, prices, active) and, in the
  membership plan card, the window list (add/edit window dates).
- `/manager/semesters` is deleted; the sidebar gets a "Dashboard" entry first.

## Technical section

### DB (destructive, nothing live; apply AFTER the code deploys)

- Drop `membership_plans.duration_days` (trial/casual never used it; insurance
  gets a fixed 365-day window in code; membership windows come from the window
  rows) and `membership_plans.period_basis` (windowed membership is now the
  only period product).
- `club_semesters` stays as the physical store for membership windows
  (renaming the table would leave generated types stale until Lovable resyncs,
  which has burned this repo before). Product language calls them
  "membership windows".
- Migration goes in `supabase/lint/migration-drift-allowlist.txt` as a
  contract-phase migration (apply after deploy), with the order documented in
  the migration header.
- `src/integrations/supabase/types.ts`: remove the two columns by hand.

### Code

- `src/lib/validation.ts`: `savePlanSchema` loses `duration_days`/`period_basis`;
  add `membershipWindowNotifications(windows, now)` (pure) and
  `insuranceSelection({insuranceEndsAt, now, daysAhead=30})` (pure);
  `startMembershipSchema` gains `include_insurance` (bool, default false).
  All pure fns get vitest coverage in `src/lib/membership.test.ts`.
- `src/lib/membership.functions.ts`:
  - `activateMembershipRow`: period kind = windowed (requires `semester_id`),
    insurance kind = paid + 365 days; trial/session unchanged.
  - `startMembership`: accepts `include_insurance`; creates a second pending
    insurance invoice with the SAME payment reference (single combined
    transfer); refuses a paid purchase with no ongoing insurance cover when
    insurance is not included; sends ONE combined payment email.
  - `reconcileUnmatched`: after the existing exact single match, try a
    group match — activate all pending invoices sharing one reference when the
    transfer amount equals their sum.
  - New `managerNotifications` server fn (manager-only) reading windows and
    returning notifications via the pure fn.
  - `listSemesterRows`/`saveSemester` keep working (agent API + plans page use
    them).
- `src/routes/_authenticated/membership.tsx`: rewrite the plan grid into
  Casual / Membership / insurance-addon UI per the rules above.
- `src/routes/_authenticated/manager.membership-plans.tsx`: drop duration and
  period-basis inputs; mount the window editor inside the membership plan card.
- New `src/routes/_authenticated/manager.index.tsx` — the dashboard with a
  notifications card + quick links.
- Delete `src/routes/_authenticated/manager.semesters.tsx`; move its editor
  into `src/components/manager/MembershipWindowsEditor.tsx` for reuse.
- `src/components/site/MemberLayout.tsx`: sidebar gains "Dashboard" first in
  the manager group, loses "Semesters".
- `src/components/site/SignInForms.tsx`: after password sign-in, managers go
  to `/manager` (members still go to `/account`). Magic-link/OAuth landing
  stays `/account` (managers still need their account page; noted).
- `src/routes/pricing.tsx`: keep mechanics; copy calls them membership windows.

### Manager agent API (contract v6, breaking)

- `list_semesters`/`save_semester` are removed and replaced by
  `list_membership_windows`/`save_membership_window` (same params).
  All four sync points change together: `src/lib/validation.ts`
  (`managerAgentActions`), `src/lib/manager-agent.ts` (manifest → version "6"
  - `changes` entry with `breaking: true`), `src/routes/api/manager/agent.ts`,
    `.claude/skills/uts-manager-agent/SKILL.md`. AGENTS.md action list updated.

### Docs

- `docs/memberships.md` rewritten for the new model (windows, mandatory
  insurance rules, dashboard notifications).
- `docs/database.md` drops the two columns; window notes updated.
- `AGENTS.md` agent-API section updated (action renames, version 6).

### Out of scope (flag if you want it)

- Combining payment: no Stripe; bank transfer only, as today.
- Auto-deriving windows from the UTS calendar (manager enters them).
- Insurance renewal chaining (renewal runs 12 months from payment, like today).
