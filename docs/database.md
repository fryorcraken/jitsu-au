# Database

The schema reference for UTS Jitsu (Supabase Postgres).

> [!IMPORTANT]
> This document describes the schema and must stay aligned with the code. The
> intended schema is defined by the timestamped migrations in
> `supabase/migrations/*.sql`. **Whenever you change a migration, a table, or
> the code that reads/writes it, update this document in the same change** so
> the doc, the migrations, and the code never drift apart. The product flows
> behind the person/waiver tables live in `docs/waivers.md`.

> [!WARNING]
> A migration file describes what the database _should_ have, not what it
> _does_. Committing a migration does not apply it — nothing in this pipeline
> runs `supabase/migrations/*.sql` against the live database (CI replays them
> onto a throwaway local Postgres, which proves only that they _can_ apply).
> This document described `waivers.approval_status` correctly for a week while
> the live column did not exist. To see the real schema, query the live database
> (`information_schema.columns`) — or read `src/integrations/supabase/types.ts`,
> which is generated from it, but may lag or carry hand-added columns. See
> `docs/database-changes.md`.

## Client grants: the schema is closed by default

Every table in `public` has RLS enabled, but RLS is only the **second** of two
locks. The first is the table grant, and Supabase's bootstrap opens it for you:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
```

So a new table arrives with all eight privileges (SELECT, INSERT, UPDATE,
DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) already granted to both client
roles.

> [!WARNING]
> **`GRANT` cannot narrow anything — only `REVOKE` can.** A migration writing
> `GRANT SELECT ON t TO authenticated` to mean "reads only" grants a privilege
> the role already holds; it reads like a restriction in review and does
> nothing. Every table in this schema sat fully open to both client roles for
> that reason until `20260728120000` (calendar) and `20260728150000` (the rest)
> revoked them. A new table needs an explicit
> `REVOKE ALL ON public.<t> FROM anon, authenticated;` **before** any intended
> grant.

The list below is the complete set of table privileges the client roles hold.
Most of the app needs none of it: it reaches the database through a server
function on the service-role client, which bypasses both grants and RLS.
`supabase/lint/client-grants-expected.txt` pins this list and
`.github/workflows/migration-drift.yml` checks it against the live database.

| Table                    | Role            | Privilege | Why                                                                             |
| ------------------------ | --------------- | --------- | ------------------------------------------------------------------------------- |
| `interest_registrations` | `anon`+`auth`   | `INSERT`  | `submitInterest` — the public interest form                                     |
| `contact_messages`       | `anon`+`auth`   | `INSERT`  | `submitContact` — the public contact form                                       |
| `waiver_templates`       | `anon`+`auth`   | `SELECT`  | `getCurrentWaiverTemplate` — the public waiver signing page                     |
| `membership_plans`       | `anon`+`auth`   | `SELECT`  | `listMembershipPlans` — the public pricing page                                 |
| `user_roles`             | `authenticated` | `SELECT`  | `useRoles` (`src/hooks/useAuth.ts`) reads the caller's own roles in the browser |
| `waivers`                | `authenticated` | `SELECT`  | the waiver-PDF storage policy sub-selects this table as the caller (see below)  |
| `calendar_events`        | `anon`+`auth`   | `SELECT`  | the public class schedule                                                       |
| `event_rsvps`            | `authenticated` | `SELECT`  | a person reads their own RSVPs                                                  |
| `calendar_feed_tokens`   | `authenticated` | `SELECT`  | a person reads their own feed-token row                                         |

Every other table grants the client roles **nothing**.

> [!IMPORTANT]
> The first four rows are **server** functions, not browser code. They run in
> `*.functions.ts` handlers but build their own client from
> `SUPABASE_PUBLISHABLE_KEY` with no user session, so PostgREST resolves them to
> `anon` and they need real grants. Grepping for imports of the shared browser
> client (`@/integrations/supabase/client`) will not find them — search for
> `createClient` as well. Revoking these without re-granting takes down the
> whole public funnel: interest form, contact form, signing page, pricing page.

Two traps worth knowing before you touch a policy or a grant:

- **An RLS policy that references another table needs a grant on that table.**
  Policy expressions are evaluated with the _caller's_ privileges, so the
  `storage.objects` policy "Owners can read their own waiver PDF" — which tests
  `EXISTS (SELECT 1 FROM public.waivers …)` — fails with `permission denied for
table waivers` unless `authenticated` holds `SELECT` there. That is the only
  reason `waivers` appears above. The sibling manager policy needs no grant
  because it goes through `has_role()`, which is `SECURITY DEFINER` — the
  standard way out.
- **A write grant makes "defence in depth" policies real.** Owner-scoped write
  policies written on the assumption that no client grant exists become live,
  reachable code paths the moment one does, bypassing rules that live in the
  server functions. That is how the calendar RSVP and feed-token bypasses
  happened, and how a manager could assign roles directly through
  `user_roles`.

This audit also turned up a table that was in the live database and nowhere
else: **`session_checkins`**, a per-event attendance model with membership
credit consumption, created directly against production with no migration, type,
doc or code in this repo. It was empty and nothing referenced it, so
`20260728170000_drop_session_checkins.sql` drops it, recording the full design in
its comment. The feature was then rebuilt deliberately in
`20260729120000_session_checkins.sql` — with the REVOKE every table now has, a
migration, generated types, tests and a product spec (`docs/check-in.md`). See
the `## Check-ins` section below for what changed from that recorded design and
why.

## People and waivers: the shape

A person = an **auth user** (their email lives on `auth.users`, the ONLY email
store) + a **`profiles` row keyed by that user id** (the person fields; no
email column anywhere in `public`). An applicant is a **locked** auth user
(banned, no credentials) created at first waiver submission; a manager's
**approval** copies the submission's details onto the profile, lifts the ban,
and emails a sign-in link (see `docs/waivers.md`). A waiver is a **frozen
submission**: exactly what was typed, the signed PDF, template version, real
signer IP and signing context, and its approval state.

- **Signing is public**: no login; only an email is required. Submissions are
  unlimited; the person's **active** waiver is the latest approved one
  (derived, not stored).
- **One email, stored once**: `auth.users.email` (unique). `waivers.email` is
  part of the frozen submission (evidence). The app resolves emails via the
  service-role-only helpers `user_id_by_email` / `user_emails`.
- **No stored full name** anywhere; composed from `first/middle/last` on read
  (`composeFullName` / `profileFullName`).

## Conventions

- **RLS on every table.** Access is enforced by Row Level Security, not the client.
- **Three Supabase clients** decide who may write (see `CLAUDE.md`): the browser
  anon client (RLS as the user), the user-scoped server middleware
  `requireSupabaseAuth` (RLS as that user), and the service-role `supabaseAdmin`
  (bypasses RLS; server-only). Waiver submission and approval both run through
  `supabaseAdmin`, so `profiles`/`waivers` need no public insert grants.
- **Roles** come from `user_roles` + the `app_role` enum, checked server-side via
  `has_role(_user_id, _role)`.
- **Money** is integer cents. **Timestamps** are `timestamptz`. **Emails** are
  stored lowercased/trimmed so the unique key dedupes case variants.
- **Storage:** the private `waivers` bucket holds the signed PDFs; access is via
  short-lived service-role signed URLs. Migration
  `20260727120000_waiver_storage_policies.sql` owns the bucket's access model:
  it asserts `public = false`, clears any dashboard-created policy scoped to the
  bucket, and adds the `storage.objects` policies below.

---

## `profiles` — the person fields for an auth user

One row per person, keyed by their auth user id. Starts as a lightweight
applicant profile (name/phone; the email lives on `auth.users`) created at
first waiver submission; filled in by manager approval. The funnel phase (lead
/ applicant / visitor / member / lapsed) is derived by `deriveLifecycleStatus`,
never stored.

| Column                           | Type          | Null | Notes                                                                                                             |
| -------------------------------- | ------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `user_id`                        | `uuid` PK     | no   | `REFERENCES auth.users(id) ON DELETE CASCADE`. The person IS the auth user.                                       |
| `first_name`                     | `text`        | yes  |                                                                                                                   |
| `middle_name`                    | `text`        | yes  |                                                                                                                   |
| `last_name`                      | `text`        | yes  |                                                                                                                   |
| `preferred_name`                 | `text`        | yes  | What they go by. NULL = none given; everything that addresses them falls back to the first name (`greetingName`). |
| `date_of_birth`                  | `date`        | yes  |                                                                                                                   |
| `address`                        | `text`        | yes  |                                                                                                                   |
| `phone`                          | `text`        | yes  |                                                                                                                   |
| `uts_student_number`             | `text`        | yes  | Drives the student pricing rate.                                                                                  |
| `emergency_contact_name`         | `text`        | yes  |                                                                                                                   |
| `emergency_contact_relationship` | `text`        | yes  | How that contact is related. For a minor this person IS the guardian who signs.                                   |
| `emergency_contact_phone`        | `text`        | yes  |                                                                                                                   |
| `medical_notes`                  | `text`        | yes  | Details of anything declared on the health questions.                                                             |
| `is_minor`                       | `boolean`     | no   | Default `false`.                                                                                                  |
| `guardian_name`                  | `text`        | yes  |                                                                                                                   |
| `guardian_relationship`          | `text`        | yes  |                                                                                                                   |
| `sms_whatsapp_consent`           | `boolean`     | no   | Default `false`.                                                                                                  |
| `created_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                  |
| `updated_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                  |

**Not stored here:** any email (lives on `auth.users`), any signature (lives
inside the waiver PDF), and no `full_name`.

**Written by (service role only):**

- Waiver submission (`submitWaiverWithPdf`): for a new email, creates a
  **locked** auth user (`ban_duration` ~100y, no credentials) and seeds the
  profile with name/phone. An existing person is left untouched. (A
  trial-interest registration creates NO person — leads are only rows in
  `interest_registrations`.)
- Manager approval (`setWaiverApproval`): copies the approved submission's
  person fields onto the profile (`waiverToProfileFields`); on first approval
  lifts the ban, sends a sign-in email, and assigns the free trial
  (`assignTrialMembership`, one per person ever, activation email suppressed).
- `ensure_profile()` trigger on `auth.users` INSERT (SECURITY DEFINER, EXECUTE
  revoked from PUBLIC/anon/authenticated): inserts the empty profile row for
  every new auth user, however created. Pure id attachment — no email matching,
  so nothing can be claimed by typing someone else's address.

**RLS:** owner reads/updates own row (`auth.uid() = user_id`); managers
read/update all; no public insert path.

### Service-role auth lookups

Two SECURITY DEFINER SQL helpers expose the one email store to the server
(EXECUTE revoked from PUBLIC/anon/authenticated, granted to `service_role`):

- `user_id_by_email(text) → uuid` — resolve a person by email at submission
  (indexed lookup on `auth.users`). **Returns NULL when nobody has that
  address**, which is the ordinary result for a new signer and what
  `submitWaiverWithPdf` branches on.
- `user_emails(uuid[]) → (user_id, email, email_confirmed_at)` — batch email
  resolution for the manager directory, invoices, and transactional emails. The
  confirmation stamp rides along so a screen can badge verified state in the
  same round trip that resolves the address. **`email_confirmed_at` is NULL**
  for anyone who has never proved their address, which is most people.

Both are called through `src/lib/supabase-rpc.ts`, never `.rpc()` directly: the
generated types print every function return as non-null, so those two NULLs
above do not exist as far as the compiler is concerned. See the warning under
"Supabase clients" in `CLAUDE.md`.

- `clear_email_confirmation(uuid) → void` — drops `auth.users.email_confirmed_at`
  back to NULL. Called immediately after a manager corrects someone's address:
  the auth admin API can _set_ a confirmation but does not reliably _clear_ one,
  and "a changed address is always unverified" has to be a guarantee rather than
  a hope about GoTrue's behaviour. Only `email_confirmed_at` is written —
  `confirmed_at` is a generated column.

---

## `waivers` — frozen submissions

| Column                           | Type          | Null | Notes                                                                                                                                                                                                           |
| -------------------------------- | ------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                                                                                                                                                    |
| `user_id`                        | `uuid`        | no   | `REFERENCES profiles(user_id) ON DELETE CASCADE`. The person (possibly-locked auth user) who submitted. Indexed.                                                                                                |
| `first_name`                     | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `middle_name`                    | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `last_name`                      | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `preferred_name`                 | `text`        | yes  | As submitted. Optional; fills the `{{preferred_name}}` template token (falling back to the first name).                                                                                                         |
| `date_of_birth`                  | `date`        | no   | As submitted.                                                                                                                                                                                                   |
| `address`                        | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `phone`                          | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `email`                          | `text`        | no   | As submitted (normalized). Part of the frozen record.                                                                                                                                                           |
| `uts_student_number`             | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `sms_whatsapp_consent`           | `boolean`     | no   | As submitted.                                                                                                                                                                                                   |
| `emergency_contact_name`         | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `emergency_contact_relationship` | `text`        | yes  | As submitted. How the contact is related; for a minor, the "relationship to minor" on the signed document.                                                                                                      |
| `emergency_contact_phone`        | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `medical_notes`                  | `text`        | yes  | As submitted. Details of anything answered yes on the health declaration; required by validation once any answer is yes.                                                                                        |
| `is_minor`                       | `boolean`     | no   | As submitted.                                                                                                                                                                                                   |
| `guardian_name`                  | `text`        | yes  | As submitted (required for minors by validation).                                                                                                                                                               |
| `guardian_relationship`          | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `pdf_path`                       | `text`        | yes  | The signed PDF in the `waivers` Storage bucket.                                                                                                                                                                 |
| `template_version`               | `int`         | yes  | Which `waiver_templates.version` was signed.                                                                                                                                                                    |
| `signer_ip`                      | `text`        | yes  | The signer's real IP (legal/forensic record).                                                                                                                                                                   |
| `signer_meta`                    | `jsonb`       | no   | Default `'{}'`. Signing-context evidence: request headers (user agent, language, client hints) + browser-reported timezone/screen/viewport/platform/languages (`buildSignerMeta`). Never copied to the profile. |
| `approval_status`                | `text`        | no   | Default `'pending'`; `CHECK IN ('pending','approved')`.                                                                                                                                                         |
| `approved_at`                    | `timestamptz` | yes  | NULL while pending.                                                                                                                                                                                             |
| `approved_by`                    | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Approving manager.                                                                                                                                              |
| `signed_at`                      | `timestamptz` | no   | When the waiver was signed.                                                                                                                                                                                     |
| `created_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                                                                                                                |

**Not stored:** `full_name`, signatures (typed or drawn), acknowledgement ticks,
and the five yes/no **health declaration** answers — all
captured inside the PDF only. The displayed **pending / active /
superseded** status is derived in the app (`deriveWaiverListStatuses`): per
person, the latest approved waiver is active.

**Grants:** `SELECT` for `authenticated`, and nothing else for either client
role. The grant is not there for anything in `src/` — it exists because the PDF
storage policy below sub-selects this table as the caller. **RLS:** owner reads
their own (`user_id = auth.uid()`); managers read all and UPDATE (approval).
Inserts are service-role only.

**PDF storage RLS** (`storage.objects`, `bucket_id = 'waivers'`): objects are
named `<waiver id>.pdf`, which is exactly what `pdf_path` stores, so ownership
is resolved by looking up the waiver row rather than by parsing the path.

| Operation                  | Who                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `SELECT`                   | the waiver's owner (`waivers.pdf_path = objects.name AND user_id = auth.uid()`), or a manager |
| `INSERT`/`UPDATE`/`DELETE` | managers only                                                                                 |

Owners deliberately get **no** write access: the PDF is frozen evidence (the
signatures and acknowledgement ticks exist only inside it), so a signer must not
be able to overwrite or delete what they signed. `anon` gets nothing. None of
this is on the app's hot path today, since uploads and downloads both run
through the service-role client, which bypasses RLS. The owner `SELECT` branch
does depend on `authenticated` holding `SELECT` on `public.waivers`, though: a
policy's subquery runs with the caller's privileges, so revoking that grant
would break it (`permission denied for table waivers`) while the manager branch,
which goes through the `SECURITY DEFINER` `has_role()`, kept working.

---

## `waiver_templates` — versioned markdown templates

| Column             | Type          | Null | Notes                                                  |
| ------------------ | ------------- | ---- | ------------------------------------------------------ |
| `id`               | `uuid` PK     | no   |                                                        |
| `version`          | `int`         | no   | `UNIQUE`.                                              |
| `title`            | `text`        | no   | Default `'Training Waiver'`.                           |
| `body_md`          | `text`        | no   | Uses `{{placeholder}}` tokens (e.g. `{{full_name}}`).  |
| `acknowledgements` | `jsonb`       | no   | Default `'[]'`. `[{id,label,required}]` checkbox defs. |
| `is_current`       | `boolean`     | no   | Partial unique index enforces exactly one `true`.      |
| `created_by`       | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.        |
| `created_at`       | `timestamptz` | no   |                                                        |

**RLS:** anyone reads the current template; managers read all and insert/update.

This is a version **history**, not a set of selectable documents: the partial
unique index means exactly one row is live, and that row is the whole of what
`/waiver` serves. Rows are added, never edited in place — a change is a new
version, so a signed waiver's `template_version` keeps meaning what it meant.

**These rows are not the evidence.** The signed PDF embeds the full template
text at signing time, so a member's own document says what they agreed to
without this table. The one gap is a waiver whose PDF never generated
(`pdf_path IS NULL`, a handled failure path in `submitWaiverWithPdf`): for that
one, `template_version` is the only pointer. So deleting an old version is
cheap-but-not-free once the club is live, and free before then.

`/manager/waiver-template` lists every version and can promote any of them
(`setCurrentWaiverTemplate`); saving in the editor appends a new version and
promotes it in one step.

---

## Membership ledger

### `membership_plans` — manager-editable catalog

`id` PK, `code` (unique), `name`, `description`, `kind`
(`insurance|trial|session|period`), `public_price_cents`, `student_price_cents`,
`duration_days`, `session_credits`, `is_active`, `sort_order`, `created_at`.
**RLS:** anyone reads active plans; managers read all and write.

### `memberships` — enrollment/billing records

`id` PK, `user_id → auth.users(id) ON DELETE SET NULL`,
`plan_id → membership_plans(id)`, `status`
(`pending|active|expired|cancelled`), `is_student`, `uts_student_number`,
`price_cents`, `payment_reference` (indexed; per-member, not unique),
`payment_method` (`bank_transfer|stripe|manual`), `paid_at`, `starts_at`,
`ends_at`, `sessions_remaining`, `session_date`, `notes`, `created_at`.
Constraint: the student rate requires a `uts_student_number`. The `member` role
is granted on paid activation. The member's display name/email come from their
profile (via `user_id`). `sessions_remaining` is set at activation and spent by a
**check-in** — see `session_checkins` below, the only writer that decrements it.
**RLS:** users read own; managers read/update all; direct member INSERT is
revoked (all inserts go through the service-role `startMembership`).

### `bank_transactions` — statement import + reconciliation

`id` PK, `import_batch`, `posted_at`, `amount_cents`, `description`, `reference`,
`raw` (jsonb), `dedupe_hash` (unique), `matched_membership_id → memberships(id)`,
`matched_at`, `matched_by → auth.users(id)`, `status`
(`unmatched|matched|ignored`), `created_at`. **RLS:** managers read; service role
writes.

---

## Calendar

The club's calendar. There is one product concept, an **entry**, which may repeat
weekly. That maps onto two tables: a repeating entry stores its rule in
`calendar_series` and the app materializes it into dated rows in
`calendar_events`, copying every detail including `visibility` and `invite_only`;
a one-off entry is a `calendar_events` row with no series. Only `calendar_events`
is ever shown. Any signed-in person may RSVP; paid members additionally see
members-only entries and get them in their personal calendar feed. See
`docs/calendar.md` for the product flows.

**`has_active_paid_membership(_user_id uuid) → boolean`** — SECURITY DEFINER SQL
helper (`SET search_path = public`) used by the events RLS policy: true when the
person has an `active` membership whose plan `kind <> 'trial'` and whose
`price_cents > 0`, mirroring `deriveLifecycleStatus`. EXECUTE is revoked from
PUBLIC/anon and granted to `authenticated` (it is evaluated inside RLS as the
querying role) + `service_role`. It is acknowledged in
`supabase/lint/advisors-allowlist.txt` for the same reason as `has_role`.

### `calendar_series` — the repeat rule for an event

A calendar entry that repeats weekly. It is a template, not a thing members see:
the public surface is the dated `calendar_events` generated from it, which copy
its details including `visibility` and `invite_only`.

| Column             | Type          | Null | Notes                                                                  |
| ------------------ | ------------- | ---- | ---------------------------------------------------------------------- |
| `id`               | `uuid` PK     | no   | `DEFAULT gen_random_uuid()`.                                           |
| `title`            | `text`        | no   | The only required detail. e.g. "Beginner Gi".                          |
| `description`      | `text`        | yes  |                                                                        |
| `instructor_name`  | `text`        | yes  | Default instructor for generated dates.                                |
| `location`         | `text`        | yes  | No default — the club picks it, or leaves it blank.                    |
| `visibility`       | `text`        | no   | `public\|members`. Default `public`. Copied onto every generated date. |
| `invite_only`      | `boolean`     | no   | Default `false`. Display badge only. Copied onto every generated date. |
| `weekday`          | `int`         | no   | `CHECK 0..6` (0 = Sunday, JS `getDay()`).                              |
| `start_time`       | `time`        | no   | Local to the club (Australia/Sydney).                                  |
| `duration_minutes` | `int`         | no   | `CHECK > 0`.                                                           |
| `starts_on`        | `date`        | no   | **Required.** First date the weekly session runs.                      |
| `ends_on`          | `date`        | yes  | **NULL = open-ended.** `CHECK ends_on >= starts_on`.                   |
| `is_active`        | `boolean`     | no   | Default `true`.                                                        |
| `created_by`       | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.                        |
| `created_at`       | `timestamptz` | no   | Default `now()`.                                                       |
| `updated_at`       | `timestamptz` | no   | Default `now()`; set app-side.                                         |

**Grants:** none for `anon`/`authenticated` — this table is reached only through
the service role. **RLS:** manager-only (read and write). Deliberately **not**
readable by anon: the
series is only the definition, the public surface is the dated `calendar_events`
generated from it, and a public grant would leak the title/instructor/day/time of
a session whose occurrences are members-only. Note `is_active = false` hides the
definition and stops further generation, but does **not** retract dates already
on the calendar — cancel those individually.

### `calendar_events` — dated occurrences and one-off events

| Column            | Type          | Null | Notes                                                                           |
| ----------------- | ------------- | ---- | ------------------------------------------------------------------------------- |
| `id`              | `uuid` PK     | no   | `DEFAULT gen_random_uuid()`.                                                    |
| `series_id`       | `uuid`        | yes  | `REFERENCES calendar_series(id) ON DELETE CASCADE`. NULL = one-off.             |
| `title`           | `text`        | no   |                                                                                 |
| `description`     | `text`        | yes  |                                                                                 |
| `instructor_name` | `text`        | yes  | Per-date override of the series instructor.                                     |
| `location`        | `text`        | yes  | No default — the club picks it, or leaves it blank.                             |
| `starts_at`       | `timestamptz` | no   | Absolute instant (indexed).                                                     |
| `ends_at`         | `timestamptz` | no   | `CHECK ends_at >= starts_at`.                                                   |
| `status`          | `text`        | no   | `scheduled\|cancelled`. Default `scheduled` (cancel keeps the row).             |
| `visibility`      | `text`        | no   | **ACCESS.** `public\|members`. Default `public`; `members` = paid members only. |
| `invite_only`     | `boolean`     | no   | **DISPLAY ONLY.** Default `false`. Badges the event; enforces nothing.          |
| `created_by`      | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.                                 |
| `created_at`      | `timestamptz` | no   | Default `now()`.                                                                |
| `updated_at`      | `timestamptz` | no   | Default `now()`; set app-side.                                                  |

Partial unique index on `(series_id, starts_at) WHERE series_id IS NOT NULL`
keeps date generation idempotent. **RLS:** everyone (incl. anon) reads
`visibility = 'public'`; a second policy adds `members` events for callers where
`has_active_paid_membership(auth.uid())` or `has_role(auth.uid(),'manager')` —
policies are OR'd, so a paid member sees both sets. Cancelled events stay
readable so the cancellation shows. Managers insert/update/delete.

### `event_rsvps` — who's coming

`id` PK, `event_id → calendar_events(id) ON DELETE CASCADE`,
`user_id → auth.users(id) ON DELETE CASCADE`, `response`
(`going|maybe|declined`), `created_at`, `updated_at`, `UNIQUE(event_id,
user_id)`. RSVP is open to **any signed-in person**, trial visitors included.
**RLS:** a person reads their own rows; managers read all (the attendance view).
Writes are **service-role only** — `authenticated` holds SELECT and nothing
else, because `setRsvp` enforces three rules RLS cannot express (no RSVP to a
members-only event you can't see, none to a cancelled event, none to one that
has already finished) and a direct client write would bypass exactly those. The
owner-scoped write policies are kept as defence in depth. Note the narrower
GRANT in the original migration did not achieve this on its own: Supabase grants
ALL on `public` to both roles by default and GRANT cannot take a privilege away,
so `20260728120000_calendar_revoke_client_grants.sql` REVOKEs them explicitly.

### `calendar_feed_tokens` — per-person private calendar links

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `token_prefix`,
`token_hash` (SHA-256, unique), `token` (the raw token, nullable), `created_at`,
`last_used_at`, `revoked_at`. Partial indexes: fast lookup of live tokens by
hash, uniqueness on a non-null `token`, and at most one live token per person.
The token rides in the URL path (`/api/calendar/<token>`) since calendar apps
can't send an auth header. There is **no public/anon feed** — a personal feed
carries members-only events only while that person is a paid member, so a
subscriber never silently misses one.

`token` exists because `/calendar` shows the member their link on every visit
rather than once at creation (`20260728180000`), and a hash cannot be reversed.
The hash column stays and is still what the feed route looks up. Rows minted
before that migration have `token IS NULL`; the server re-mints those in place
the next time their owner opens the page, which retires the old URL.

**RLS:** a person reads their own token row; minting and feed lookup run through
the service role; `authenticated` gets SELECT only, so a client cannot clear its
own `revoked_at`. The owner's row now carries the live token, which is what the
page shows them anyway. There is no member-facing rotate or revoke: the link is
permanent, the way a private ICS address is in any calendar app.

---

## Check-ins

The attendance record, and the only thing in this app that ever spends a
membership's session credits. Product spec: **`docs/check-in.md`**.

### `session_checkins` — who was on the mat, and what paid for it

`id` PK, `event_id → calendar_events(id) ON DELETE CASCADE`,
`user_id → profiles(user_id) ON DELETE CASCADE`, `checked_in_at` (NOT NULL,
defaults to now), `checked_in_by → auth.users(id) ON DELETE SET NULL`,
`coverage` (NOT NULL, `trial|session|period|none`, default `none`),
`membership_id → memberships(id) ON DELETE SET NULL`, `consumed_credit`
(NOT NULL boolean), `closed_membership` (NOT NULL boolean), `warnings`
(NOT NULL `text[]`, default `{}`), `note`.

**Constraints.** `UNIQUE (event_id, user_id)` — one check-in per person per
class, and half the concurrency guard: the server inserts the row _before_
touching any credit and lets `23505` pick the loser of a race. It only guards
_creating_ a check-in; attaching cover to an existing row is guarded in the
server, which claims the row with `WHERE coverage = 'none'` and refunds what it
took if it loses. Two CHECKs keep the record coherent: an uncovered check-in has
no membership, and a closed membership must have consumed a credit.

Two constraints are deliberately ABSENT, both because `membership_id` is
`ON DELETE SET NULL`: that runs an `UPDATE` on the check-in row, CHECKs are
re-evaluated on `UPDATE`, and either would abort a `DELETE FROM memberships` with
a cryptic error. So there is no biconditional on the first, and no
`consumed_credit = false OR membership_id IS NOT NULL`. The write path already
guarantees both; what survives a deleted membership is an honest "a credit was
spent, from a membership that no longer exists".

**Indexes.** `(user_id)` for the per-person attendance count, and a partial
`(checked_in_at DESC) WHERE coverage = 'none'` for the needs-attention list —
the only query that scans across events. No standalone `(event_id)` index: the
UNIQUE index already leads on it.

**`coverage` is stored, not derived**, mirroring `membership_plans.kind` plus
`none`. A manager may edit a plan's kind afterwards, and that must not rewrite
what happened, the same reason a waiver freezes its submission. `insurance` is
absent from the list on purpose: yearly insurance is affiliation, never mat time.
`warnings` holds stable machine codes (`checkInWarnings` in
`src/lib/validation.ts`), never sentences, so the wording can change without a
migration.

**Grants.** `REVOKE ALL FROM anon, authenticated` before anything else, then
`GRANT ALL TO service_role`. The client roles hold **nothing**: every read and
write goes through a manager-only server function
(`src/lib/checkin.functions.ts`), so nothing here appears in
`supabase/lint/client-grants-expected.txt`.

**RLS:** managers select/insert/update/delete via `has_role()`, and a person may
read their own rows. With no client grant these policies are unreachable; they
are defence in depth, already correct on the day someone adds a grant.

**Related writes.** `memberships.sessions_remaining` is set once at activation
(`activateMembershipRow`) and decremented only here, with a compare-and-set on
the balance that was read. When it reaches zero the membership's status becomes
`expired` and `closed_membership` records that this check-in did it, so undo
reverses exactly what happened rather than guessing.

---

## Manager / infrastructure tables

### `user_roles`

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `role` (`app_role`:
`manager|member`), `created_at`, `UNIQUE(user_id, role)`. **Grants:** `SELECT`
for `authenticated` (`useRoles` reads the caller's own roles in the browser);
no client write grant, so role changes are service-role only. **RLS:** users read
own; managers read/insert/delete all. Checked via `has_role()`.

The manager insert/delete policies are defence in depth, not a supported path.
They were reachable directly from a manager's browser session until
`20260728150000` revoked the write grants that Supabase's defaults had left in
place — a manager could `POST /rest/v1/user_roles` and assign `manager` to
anyone, bypassing `assignTrialMembership`'s service-role path. Keep the write
grants off.

### `club_settings` — manager key/value store

`key` PK, `value`, `updated_at`, `updated_by → auth.users(id)`. First use:
markdown `invoice_payment_instructions`. **RLS:** manager-only.

### `email_verification_tokens` — proof that someone can read an address

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE` (**nullable**), `email`
(normalized, the address being proven), `purpose`
(`interest | waiver | manager_resend | self_resend | email_change`),
`token_prefix`, `token_hash` (SHA-256, unique; raw never stored), `created_at`,
`expires_at`, `last_used_at`, `revoked_at`. Partial indexes on the hash and on
the email, both `WHERE revoked_at IS NULL`.

The verified state itself is **not** here — it lives on
`auth.users.email_confirmed_at`, which Supabase already stamps on a magic-link
sign-in. This table only holds the links that let someone prove an address any
other way, and two things about it differ from the other token tables on
purpose:

- **`user_id` is nullable.** A token minted for an interest registration belongs
  to a **lead**, who has no person record yet. It binds to the address, and the
  proof is applied at waiver submission when the person is created (they are
  born verified). Binding to a user id would make that journey impossible.
- **Tokens are reusable, not single-use.** The interest token also rides on the
  waiver prefill link that people return to, and confirming twice is a no-op.
  `last_used_at` records the latest redemption instead of burning the row.

A token only ever proves the address it was mailed to: redemption re-checks it
against the account's current email, so links sent before a manager corrected a
typo are inert. Expiry is 180 days.

**RLS:** enabled with **no policies** and no client grants (`REVOKE ALL` from
anon/authenticated) — unlike `calendar_feed_tokens` there is nothing here a
person needs to see about their own row, so minting, redeeming and revoking all
run through the service role.

### `manager_api_tokens` — manager agent API credentials

`id` PK, `label`, `token_prefix`, `token_hash` (SHA-256, unique; raw shown once),
`created_by → auth.users(id)`, `created_at`, `last_used_at`, `revoked_at`.
Partial index on live tokens. **RLS:** manager-only; auth/creation via
service-role functions.

### `app_user_connections` — per-user connector credentials

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `connector_id`,
`connection_key_ciphertext`, `connected_email`, `metadata` (jsonb),
`created_at`, `updated_at`, `UNIQUE(user_id, connector_id)`. **RLS:** enabled;
service role only.

### `waiver_drive_uploads` — per-manager Drive export tracking

`id` PK, `waiver_id → waivers(id) ON DELETE CASCADE`,
`manager_user_id → auth.users(id) ON DELETE CASCADE`, `drive_file_id`,
`drive_web_view_link`, `uploaded_at`, `UNIQUE(waiver_id, manager_user_id)`.
**RLS:** enabled; service role only.

---

## Public intake (anon insert-only)

### `interest_registrations`

`id` PK, `name`, `email`, `phone`, `uts_student`, `experience`, `message`,
`sms_whatsapp_consent`, `created_at`. **RLS:** anon INSERT under a validating
`WITH CHECK` (name/email/phone/experience/message length + email format).
Each row is a **lead**: kept exactly as submitted, creating no person record.
The manager directory merges leads in by normalized email until the email
belongs to a person (they signed the waiver).

### `contact_messages`

`id` PK, `name`, `email`, `subject`, `message`, `created_at`. **RLS:** anon
INSERT under a validating `WITH CHECK`.

---

## `auth.users` (Supabase-managed)

The person's one identity record, managed by Supabase Auth (not in our
migrations) — **the only place any email lives**. An applicant's auth user is
created **locked** (banned, no credentials) by waiver submission; approval
lifts the ban. There is no self-serve sign-up. Two triggers fire:

- `handle_new_user_role` — grants `manager` to a confirmed whitelisted address.
- `ensure_profile` — inserts the empty `profiles` row for every new auth user.
  EXECUTE is revoked from the public RPC surface.

`profiles.user_id`, `waivers.user_id`, `memberships.user_id`,
`user_roles.user_id` and the various `*_by` columns reference it. The server
reads emails via `user_id_by_email` / `user_emails` (service-role-only).

`email_confirmed_at` on this table is the **only** record of whether an address
has been verified — deliberately not copied onto `profiles`, so there is nothing
to drift. It means one thing: someone opened a link the club sent there. Supabase
sets it natively on a magic-link sign-in; `email_verification_tokens` covers the
other routes; and `clear_email_confirmation` drops it whenever a manager changes
the address. Nothing in the product can assert it by hand.
