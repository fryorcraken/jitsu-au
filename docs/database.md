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
`supabase/lint/client-grants-expected.txt` pins this list, and
`supabase/lint/check-client-grants.py` is pointed at two databases. Against the
**local replay** it runs in CI, on every `supabase/**` pull request
(`.github/workflows/supabase-lint.yml` replays every migration into a throwaway
Postgres), so a table left open by its own migration fails the PR that adds it.
Against the **live** database it is run by hand — CI cannot reach that one at
all (see `supabase/lint/README.md`).

| Table                    | Role            | Privilege | Why                                                                                                                                                                                               |
| ------------------------ | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interest_registrations` | `anon`+`auth`   | `INSERT`  | `submitInterest` — the public interest form                                                                                                                                                       |
| `contact_messages`       | `anon`+`auth`   | `INSERT`  | `submitContact` — the public contact form                                                                                                                                                         |
| `waiver_templates`       | `anon`+`auth`   | `SELECT`  | `getCurrentWaiverTemplate` — the public waiver signing page                                                                                                                                       |
| `membership_plans`       | `authenticated` | `SELECT`  | `listMembershipPlans` — the member purchase screen (`/membership`). The public pricing page (`/pricing`) is hand-written copy and does not read this table — see the "Membership ledger" section. |
| `user_roles`             | `authenticated` | `SELECT`  | `useRoles` (`src/hooks/useAuth.ts`) reads the caller's own roles in the browser                                                                                                                   |
| `waivers`                | `authenticated` | `SELECT`  | the waiver-PDF storage policy sub-selects this table as the caller (see below)                                                                                                                    |
| `calendar_events`        | `anon`+`auth`   | `SELECT`  | the public class schedule                                                                                                                                                                         |
| `event_rsvps`            | `authenticated` | `SELECT`  | a person reads their own RSVPs                                                                                                                                                                    |
| `calendar_feed_tokens`   | `authenticated` | `SELECT`  | a person reads their own feed-token row                                                                                                                                                           |
| `blog_posts`             | `anon`+`auth`   | `SELECT`  | `listPublishedBlogPosts`/`getBlogPostBySlug` — the public blog                                                                                                                                    |
| `blog_comments`          | `anon`+`auth`   | `SELECT`  | `listComments` — visible comments on a published post                                                                                                                                             |
| `blog_comment_upvotes`   | `authenticated` | `SELECT`  | a person reads their own upvotes, to show a comment as already upvoted                                                                                                                            |

Every other table grants the client roles **nothing**.

> [!NOTE]
> **A table's `REVOKE` may live under a different name.** Grants attach to the
> object, not to its name, so a `REVOKE` survives a later
> `ALTER TABLE … RENAME TO`. The knowledge base is the standing example:
> `kb_articles`, `kb_article_versions` and `kb_annotations` are closed by
> `20260731140000_documents.sql`, which revoked them as `documents`,
> `document_versions` and `document_annotations` before
> `20260802100000_knowledge_base.sql` renamed all three. Searching the
> migrations for `REVOKE ... kb_articles` finds nothing and means nothing — a
> full replay of `supabase/migrations` yields the 18 grants in the table above
> and not one more, which is what the CI check now asserts.

> [!IMPORTANT]
> The first five rows are **server** functions, not browser code. They run in
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

### What the schema scanners make of a closed table

Because almost every table here grants the client roles nothing, a scanner that
reads policies without reading grants keeps reporting the same three shapes, and
none of them is a finding. Supabase's **dashboard schema review** raises them by
design and has no allowlist, so they come back on every scan — the same standing
situation as the advisors (see `supabase/lint/README.md`). The answer, once:

- **"RLS enabled but no policies"** on `app_user_connections` and
  `waiver_drive_uploads`. Fail-closed and intentional: both are written and read
  exclusively by a server function on the service-role client — connector
  ciphertext by `src/lib/app-user-connections.server.ts`, the Drive export by
  `src/lib/google-drive.functions.ts`.
- **"no policy allows public/authenticated read"** on `calendar_series`. Also
  intentional, and the one place where adding the policy would be the
  regression: a series is the repeat rule, the public surface is the dated
  `calendar_events` generated from it, and a client-readable series would leak
  the title, instructor, day and time of a session whose occurrences are
  members-only. See the `calendar_series` section below.
- **"only a manager `SELECT` policy, no write policies"** on
  `bank_transactions`. The third shape, and the most interesting one, because it
  is the argument this whole section rests on: the table _does_ carry
  `"Managers can view bank transactions"` from `20260722000000`, but the grant
  that made it reachable went in `20260728150000`, so it is as closed as the two
  above. Statement import and reconciliation run on the service role
  (`src/lib/membership.functions.ts`), and so does the manager screen that reads
  the result. A policy surviving its grant is not a leftover to tidy up — it is
  what every policy on a closed table is (see below).

A closed table is not exempt from having correct policies, though. The policies
are defence in depth for the day a grant is added back, and one that does not
encode the rule the app enforces is worse than none, because it reads as a
reviewed decision. `20260807010000_kb_versions_current_only.sql` is the worked
example: a scanner flagged `kb_article_versions` for admitting every version of a
`members` article, which was true of the policy and never true of the app.

## RLS-only helpers live in `private`

The way out of the first trap above is a `SECURITY DEFINER` helper: the policy
calls a function that runs as its owner, so it can read a table the caller has no
grant on. The cost is that the caller needs `EXECUTE` on that function, and a
policy expression is evaluated as the **querying** role — so an anon-readable
table's policy means granting `EXECUTE` to `anon`.

Everything in `public` is routable. That grant therefore also lets anyone with
the publishable key call the helper directly as
`POST /rest/v1/rpc/<name>`, with arguments of their choosing, which is what
Supabase advisors 0028/0029 (`*_security_definer_function_executable`) report.

So the schema a helper lives in follows from who calls it:

| Helper                                                             | Schema    | Why                                                                            |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------ |
| `has_role`, `has_active_paid_membership`, the `user_emails` family | `public`  | the app calls them over PostgREST (`.rpc(...)`), so they have to stay routable |
| `event_is_invite_only`, `is_event_invitee`, `is_commenter_blocked` | `private` | only an RLS policy ever calls them, so nothing needs them routable             |

> [!IMPORTANT]
> **Staying routable is not the same as answering anyone.** A function
> `authenticated` may execute is reachable as `POST /rest/v1/rpc/<name>` with the
> anon key and any session, so a `_user_id` parameter it does not check is an
> oracle about other people. `has_role` and `has_active_paid_membership` both
> had exactly that: given a uuid — and `blog_comments` publishes `user_id` beside
> the commenter's name, while `calendar_events` publishes `created_by` — anyone
> signed in could ask whether a named person was a manager or a paying member.
>
> `20260820000000_scope_role_helpers_to_caller.sql` closed it: each now answers
> only when `_user_id = auth.uid()`, or when there is no `auth.uid()` at all
> (the service role, which legitimately asks about anybody). RLS policies pass
> `auth.uid()` and caller-scoped server functions pass their own `context.userId`,
> so nothing legitimate changed. Both still return FALSE rather than NULL when
> they refuse — see the RPC-nullability note in `CLAUDE.md`.
>
> A new `public` SECURITY DEFINER helper that takes a user id needs the same
> guard, or it needs to live in `private`.

PostgREST routes `/rest/v1/rpc/*` only to the schemas in its `db-schemas` list
(`public, graphql_public`), so a function in `private` is unreachable from the
API while RLS can still call it. `anon`/`authenticated` hold `USAGE` on the
schema (a prerequisite for `EXECUTE`, and nothing on its own) plus `EXECUTE` on
the individual helpers. Migration `20260802000000_private_rls_helpers.sql`
created the schema and moved the three helpers into it.

> [!IMPORTANT]
> **`private` is an API boundary, not a privilege boundary.** `anon` keeps
> `USAGE` on the schema and `EXECUTE` on `event_is_invite_only` — it has to, or
> the anon read policy fails. What stops the outside world calling it is only
> that `private` is absent from **Settings → API → Exposed schemas**. Add it
> there and all three helpers are routable again, with no migration to review
> and nothing for CI or the advisors to report (both lints scan the exposed
> schemas only). So: never add `private` to that list, and check it is still
> `public, graphql_public` when verifying a migration that touches this schema.

**No tables belong in `private`, only helper functions.** Supabase's bootstrap
`ALTER DEFAULT PRIVILEGES` is scoped to `public`, so objects created in `private`
do not arrive pre-granted the way a new `public` table does — but a table hidden
from PostgREST is a table whose access rules stop being reviewable, which is the
opposite of what this schema is for.

> [!WARNING]
> **Every helper added to `private` needs its own explicit
> `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, and nothing will remind you.**
> Postgres grants `EXECUTE` to `PUBLIC` on every new function. Unlike the table
> case there is no default-privileges fix:
> `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is
> accepted silently and does nothing, because the built-in `PUBLIC` grant is an
> implicit NULL ACL with no stored entry to revoke from. And the advisors scan
> only the exposed schemas, so a `private` helper that forgets the `REVOKE` is
> world-executable with no finding and no CI failure. The `REVOKE` line under
> each function in `20260802000000` is the entire guard.

When a helper's only caller is a policy, move it here rather than adding a line
to `supabase/lint/advisors-allowlist.txt`; acknowledge a finding only when the
function has a real PostgREST caller.

## People and waivers: the shape

A person = an **auth user** (their email lives on `auth.users`, the ONLY email
store) + a **`profiles` row keyed by that user id** (the person fields; no
email column anywhere in `public`). An applicant is a **locked** auth user
(banned, no credentials) created at first waiver submission; a manager's
**approval** promotes the submission onto the profile and opens the account
(`docs/waivers.md`, rule 6, is where what approval does is written down). A
waiver is a **frozen submission**: exactly what was typed, the signed PDF,
template version, real signer IP and signing context, and its approval state.

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

| Column                           | Type          | Null | Notes                                                                                                                                                                           |
| -------------------------------- | ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`                        | `uuid` PK     | no   | `REFERENCES auth.users(id) ON DELETE CASCADE`. The person IS the auth user.                                                                                                     |
| `first_name`                     | `text`        | no   | Non-blank (`profiles_first_name_not_blank`). Every person has a name to show; `ensure_profile` seeds one when the auth user arrives.                                            |
| `middle_name`                    | `text`        | yes  |                                                                                                                                                                                 |
| `last_name`                      | `text`        | yes  |                                                                                                                                                                                 |
| `preferred_name`                 | `text`        | yes  | What they go by. NULL = none given; everything that addresses them falls back to the first name (`greetingName`).                                                               |
| `display_name`                   | `text`        | yes  | 1–60 chars. What they've chosen to show on blog and document comments. NULL = derived (`commentDisplayName`): first/preferred name + last initial.                              |
| `date_of_birth`                  | `date`        | yes  |                                                                                                                                                                                 |
| `address`                        | `text`        | yes  |                                                                                                                                                                                 |
| `phone`                          | `text`        | yes  |                                                                                                                                                                                 |
| `uts_student_number`             | `text`        | yes  | Drives the student pricing rate.                                                                                                                                                |
| `emergency_contact_name`         | `text`        | yes  |                                                                                                                                                                                 |
| `emergency_contact_relationship` | `text`        | yes  | How that contact is related. Not the guardian by definition: for a minor the two may be different people.                                                                       |
| `emergency_contact_phone`        | `text`        | yes  |                                                                                                                                                                                 |
| `medical_notes`                  | `text`        | yes  | Details of anything declared on the health questions.                                                                                                                           |
| `is_minor`                       | `boolean`     | no   | Default `false`.                                                                                                                                                                |
| `guardian_name`                  | `text`        | yes  | The parent/legal guardian of a minor, promoted from their approved waiver.                                                                                                      |
| `guardian_relationship`          | `text`        | yes  |                                                                                                                                                                                 |
| `guardian_address`               | `text`        | yes  | The guardian's own address. Resolved at signing: equals the participant's when the signer left it blank as "same as".                                                           |
| `guardian_phone`                 | `text`        | yes  | The guardian's own mobile, resolved the same way.                                                                                                                               |
| `guardian_email`                 | `text`        | yes  | The guardian's own email, resolved the same way. **Not a login** — the only email anyone signs in with lives on `auth.users`, and it is the participant's.                      |
| `sms_whatsapp_consent`           | `boolean`     | no   | Default `false`.                                                                                                                                                                |
| `gi_size`                        | `text`        | yes  | Gi size code (`profiles_gi_size_check`: `000`…`7`). Equipment sizing, never on a waiver. Chart: `src/lib/kit-sizes.ts`.                                                         |
| `belt_size`                      | `text`        | yes  | Belt size code (`profiles_belt_size_check`: `0`…`7` — the belt chart has no `000`/`00`). Same module owns both lists.                                                           |
| `martial_arts_experience`        | `text`        | yes  | Free text, ≤500 chars (`profiles_martial_arts_experience_check`). Collected on `/waiver`, never on a waiver submission or the PDF — context for instructors, not a declaration. |
| `media_consent`                  | `boolean`     | yes  | Media/promotional-photo consent, live. Three-state: NULL = never asked, and NOT the same as `false`.                                                                            |
| `media_consent_updated_at`       | `timestamptz` | yes  | When `media_consent` was last set by hand, by the member or a manager. NULL when it came from an approved waiver.                                                               |
| `media_consent_updated_by`       | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Who set it. Equal to `user_id` when the member did it themselves, else a manager; NULL from a waiver.                           |
| `created_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                                                                                |
| `updated_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                                                                                |

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
  lifts the ban, sends the account-activated email, and assigns the free trial
  (`assignTrialMembership`, one per person ever, activation email suppressed).
  That trial's `starts_at` is the start of the club day the waiver was **signed**
  (`signed_at`) rather than the approval instant, so it records when the
  entitlement was earned. Nothing reads it as a limit: a credit balance is not
  date-gated at check-in (`docs/check-in.md`).
  `media_consent` is the one field the patch can OMIT rather than set: a
  submission carrying NULL was signed on a template that never asked, and must
  not erase a consent the club already holds. When it does carry one, and that
  submission is actually newer than whatever set the profile's current answer
  (`supersedesMediaConsent`, guarding against approving out of chronological
  order — an old ticked box must never overwrite a withdrawal made more
  recently on `/account`), the freshly signed answer wins and the two
  `media_consent_updated_*` columns are cleared with it, since the value no
  longer came from whoever set it by hand.
- Waiver submission again, for the optional **gi size** the form collects
  (`submitWaiverWithPdf`). It is equipment sizing, not part of the waiver: no
  `waivers` column holds it and it is not on the PDF, so it is written straight
  here. A blank one writes nothing, so re-signing never clears a size on file,
  and `belt_size` is only ever SEEDED (`beltSizeForGiSize`, which sends the two
  kids' gi sizes to belt `0`) so a size somebody chose deliberately survives.
- Waiver submission again, for the optional **previous martial arts
  experience** the form collects (`submitWaiverWithPdf` /
  `applyWaiverMartialArtsExperience`). Same treatment as gi size: not part of
  the waiver, no `waivers` column, not on the PDF, written straight here, and a
  blank value writes nothing so re-signing never clears one on file.
- The member themselves, from `/account` (`updateMyProfile`): `display_name`,
  `preferred_name`, `phone`, `address`, `sms_whatsapp_consent`, `media_consent`,
  the three `emergency_contact_*` fields, `gi_size` and `belt_size`. The schema
  is `.strict()`, so it cannot reach the legal name, date of birth, student
  number, medical notes, minor/guardian fields or email. `media_consent` is the
  one field here that is NOT nullable: null means "the club has never asked",
  which is a fact about the club's records rather than an answer a member can
  give, so nothing can restore it once it is set (there is no manager path back
  to NULL either — see below). Saving it also stamps the two
  `media_consent_updated_*` columns with the MEMBER's own id, which is what
  lets the person page tell their own change apart from one a manager recorded
  before that write path existed. ⚠️ Its contact fields OVERLAP with
  `waiverToProfileFields`, so a manager approving an older waiver can overwrite
  a correction made here; `/account` says so on the card.
- A manager, from a person's detail page (`setClubUserKitSizes`): `gi_size` and
  `belt_size` only, either of which may be set to NULL to clear it. There is no
  equivalent for `media_consent`: the person page shows the club's current
  answer and its provenance, but a manager cannot set or clear it there. The
  only writers are the member themselves, above, and waiver approval, above —
  a manager who is told about a photo request in person points the member at
  `/account` rather than acting on it directly.
- `ensure_profile()` trigger on `auth.users` INSERT (SECURITY DEFINER, EXECUTE
  revoked from PUBLIC/anon/authenticated): inserts the profile row for every new
  auth user, however created. Pure id attachment — no email matching, so nothing
  can be claimed by typing someone else's address. It seeds `first_name` (which
  is NOT NULL) from the auth user's metadata, else the literal `Member`; the
  waiver path overwrites that with the submitted name in the same request, so
  the seed only survives for an auth user created outside the product
  (dashboard, invite). The fallback exists so a missing name can never abort the
  `auth.users` insert, and it is deliberately not the email's local part —
  `first_name` is shown publicly on blog comments and greets people in email.
  The trigger only fires on INSERT, so auth users predating it had no row at
  all until `20260802093000` backfilled them.

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

| Column                           | Type          | Null | Notes                                                                                                                                                                                                            |
| -------------------------------- | ------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                                                                                                                                                     |
| `user_id`                        | `uuid`        | no   | `REFERENCES profiles(user_id) ON DELETE CASCADE`. The person (possibly-locked auth user) who submitted. Indexed.                                                                                                 |
| `first_name`                     | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `middle_name`                    | `text`        | yes  | As submitted.                                                                                                                                                                                                    |
| `last_name`                      | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `preferred_name`                 | `text`        | yes  | As submitted. Optional; fills the `{{preferred_name}}` template token (falling back to the first name).                                                                                                          |
| `date_of_birth`                  | `date`        | no   | As submitted.                                                                                                                                                                                                    |
| `address`                        | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `phone`                          | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `email`                          | `text`        | no   | As submitted (normalized). Part of the frozen record.                                                                                                                                                            |
| `uts_student_number`             | `text`        | yes  | As submitted.                                                                                                                                                                                                    |
| `sms_whatsapp_consent`           | `boolean`     | no   | As submitted.                                                                                                                                                                                                    |
| `media_consent`                  | `boolean`     | yes  | The media/photo consent tick, as submitted. NULL when the template signed had no media acknowledgement. Derived server-side from the ticks, never sent by the client. Frozen; a later withdrawal never edits it. |
| `emergency_contact_name`         | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `emergency_contact_relationship` | `text`        | yes  | As submitted. How the contact is related. A minor's guardian is a separate person with their own columns below.                                                                                                  |
| `emergency_contact_phone`        | `text`        | no   | As submitted.                                                                                                                                                                                                    |
| `medical_notes`                  | `text`        | yes  | As submitted. Details of anything answered yes on the health declaration; required by validation once any answer is yes.                                                                                         |
| `is_minor`                       | `boolean`     | no   | As submitted.                                                                                                                                                                                                    |
| `guardian_name`                  | `text`        | yes  | As submitted (required for minors by validation). The person who signed and carries the liability, who may not be the emergency contact.                                                                         |
| `guardian_relationship`          | `text`        | yes  | As submitted (required for minors by validation).                                                                                                                                                                |
| `guardian_address`               | `text`        | yes  | As submitted, resolved: the guardian's own, or the participant's when the signer left it blank as "same as". NULL for an adult.                                                                                  |
| `guardian_phone`                 | `text`        | yes  | As submitted, resolved the same way. NULL for an adult.                                                                                                                                                          |
| `guardian_email`                 | `text`        | yes  | As submitted, resolved the same way. Evidence only; the person record is keyed on the participant's email. NULL for an adult.                                                                                    |
| `pdf_path`                       | `text`        | yes  | The signed PDF in the `waivers` Storage bucket.                                                                                                                                                                  |
| `template_version`               | `int`         | yes  | Which `waiver_templates.version` was signed.                                                                                                                                                                     |
| `signer_ip`                      | `text`        | yes  | The signer's real IP (legal/forensic record). NULL for a scanned paper form, where nobody connected to sign.                                                                                                     |
| `signer_meta`                    | `jsonb`       | no   | Default `'{}'`. Signing-context evidence: request headers (user agent, language, client hints) + browser-reported timezone/screen/viewport/platform/languages (`buildSignerMeta`). Never copied to the profile.  |
| `approval_status`                | `text`        | no   | Default `'pending'`; `CHECK IN ('pending','approved')`.                                                                                                                                                          |
| `approved_at`                    | `timestamptz` | yes  | NULL while pending.                                                                                                                                                                                              |
| `approved_by`                    | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Approving manager.                                                                                                                                               |
| `signed_at`                      | `timestamptz` | no   | When the waiver was signed.                                                                                                                                                                                      |
| `client_submission_id`           | `uuid`        | yes  | The browser's per-form-fill idempotency key, behind a partial unique index. Looked up before any work so a retry cannot mint a second signed waiver. See "Public intake" below.                                  |
| `created_at`                     | `timestamptz` | no   | Default `now()`.                                                                                                                                                                                                 |

**Not stored:** `full_name`, signatures (typed or drawn), acknowledgement ticks,
and the five yes/no **health declaration** answers — all
captured inside the PDF only. **One exception:** the `media` acknowledgement is
also copied to `media_consent` above, on the same test that gives
`medical_notes` a column — the club has to act on it week to week, and nobody
opens forty PDFs before posting a photo. The PDF is still the record of what was
agreed; the column is a derived copy. The displayed **pending / active /
superseded** status is derived in the app (`deriveWaiverListStatuses`): per
person, the latest approved waiver is active.

**How a submission arrived** is not a column. A waiver filed from a scanned
paper form (`/manager/waivers/upload`) is an ordinary row in every respect
(approved, superseded and downloaded identically); the one difference is its
`signer_meta`, which records who filed it rather than which browser signed it:
`source: "paper_upload"`, `uploaded_by`, `uploaded_by_email`, `uploaded_at` and
`scan_files`. `isPaperWaiver()` is the single reader of that marker. If paper
waivers ever need to be queried or reported on in bulk, promote it to a real
`source` column then, rather than filtering on jsonb.

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
`/waiver` serves. **The text is never edited in place** — changing the wording
means a new row with a new version number, so a signed waiver's
`template_version` keeps meaning what it meant. `is_current` is the one field
that does move between rows, which is what promoting a version is.

**These rows are not the evidence.** The signed PDF embeds the full template
text at signing time, so a member's own document says what they agreed to
without this table. The one gap is a waiver whose PDF never generated
(`pdf_path IS NULL`, a handled failure path in `submitWaiverWithPdf`): for that
one, `template_version` is the only pointer. So deleting an old version is
cheap-but-not-free once the club is live, and free before then.

That is why the history here is short. **On 2026-07-29, before the club took any
real signature, version 1 (`UTS Jitsu Training Waiver`, the short two-tick
waiver) was deleted outright** and version 2 (`UTS Jitsu Application Form`) was
promoted, leaving one row —
`20260729140000_waiver_template_single_version.sql`. A `waivers` row pointing at
a version that is not in this table dates from before then. Deleting a version
is not the normal course; see `docs/waivers.md`.

`/manager/waiver-template` lists every version and can promote any of them
(`setCurrentWaiverTemplate`); saving in the editor appends a new version as a
draft and then promotes it, so a failed save never leaves the club with no live
waiver.

---

## Membership ledger

See `docs/memberships.md` for the product flows (plan catalogue, dated plans,
no pro rata, staying a member through the break).

### `membership_plans` — manager-editable catalog

`id` PK, `code` (unique), `name`, `description`, `kind`
(`insurance|trial|session|period`), `public_price_cents`, `student_price_cents`,
`duration_days`, `session_credits`, `is_active`, `sort_order`, `starts_on`,
`ends_on` (inclusive — the last day of training), `created_at`. A plan resolves
its own window with no second table to look up: `starts_on`/`ends_on` both set
means a fixed date range (e.g. "Semester 2 2026", 20 Jul – 16 Dec — everyone who
buys it gets exactly those dates, full price regardless of when in it they
join; there is no pro rata); `duration_days` set means a rolling window from
payment (yearly insurance, 365 days); neither set means the plan ends with its
session credits instead of a date (trial, casual class). Three CHECK
constraints enforce this is mutually exclusive
(`membership_plans_dates_paired`, `membership_plans_dates_order`,
`membership_plans_dates_xor_duration`). Each training period the club sells is
its own row — "Semester 2 2026" and "Semester 1 2027" can be priced
differently — rather than a shared plan pointing at a separate table of
windows; this table used to be paired with `club_semesters` and a
`period_basis` discriminator. `period_basis` was already dropped
(`20260803120000_membership_windows_contract.sql`); `club_semesters` and
`memberships.semester_id` drop once every plan carries its own dates directly
(`20260804010000_membership_plans_own_dates_contract.sql`).
**RLS:** managers read all and write; `authenticated` reads active plans (the
member purchase screen, `/membership`). There is deliberately no `anon` grant:
the public pricing page (`/pricing`) is hand-written copy, not driven by this
catalogue — a marketing page cannot show a single price once more than one
dated plan is on sale at once.

### `memberships` — enrollment/billing records

`id` PK, `user_id → auth.users(id) ON DELETE SET NULL`,
`plan_id → membership_plans(id)`, `status`
(`pending|active|expired|cancelled`), `is_student`, `uts_student_number`,
`price_cents`, `payment_reference` (indexed; per-member, not unique),
`payment_method` (`bank_transfer|stripe|manual`), `paid_at`, `starts_at`,
`ends_at`, `sessions_remaining`, `session_date`, `notes`, `created_at`.
`status` is about PERMISSION TO TRAIN, never money: `active` means authorised,
and a membership is authorised the moment it is raised. `paid_at` is the money,
written only by `recordMembershipPayment` (bank reconciliation, or a manager
marking it paid), and it is what the delete guard reads. `pending` is no longer
produced by anything and survives only on rows created before the two were
separated; `isUnpaid` in `src/lib/validation.ts` is the one definition of who
still owes the club money. `expired` covers two different endings — a date
passing, and a credit plan's classes running out — so no screen prints it raw:
what a person reads comes from the plan's kind (see "What an ended membership is
called" in `docs/memberships.md`).
Constraint: the student rate requires a `uts_student_number`. The `member` role
is reconciled against these rows by `syncMemberRole` after every activation,
cancellation and deletion — it is a label, not the access gate (see the
"Membership ledger" note in `docs/memberships.md`). The member's display
name/email come from their profile (via `user_id`). For a dated plan,
`starts_at`/`ends_at` are the plan's own dates (`starts_on` at 00:00 and
`ends_on` at 23:59:59, both Australia/Sydney), computed once at activation and
never touched again. `sessions_remaining` is set at activation and spent by a
**check-in** — see `session_checkins` below, the only writer that decrements it.
**RLS:** users read own; managers read/update all; direct member INSERT is
revoked (all inserts go through the service-role `startMembership` /
`createMembershipForUser`). **Deletes** have no policy at all: a manager
deleting a junk invoice goes through the service-role `deleteMembershipRow`,
which bypasses RLS, so there is nothing to grant. Its guards
(`whyMembershipCannotBeDeleted`) are the real gate, and one of them exists
because `session_checkins.membership_id` is `ON DELETE SET NULL`: deleting a
membership somebody trained on would silently orphan the check-in rather than
fail.

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
helper (`SET search_path = ''`) used by the events RLS policy: true when the
person has an `active` membership whose plan `kind <> 'trial'` and whose
`price_cents > 0`, mirroring `deriveLifecycleStatus`. EXECUTE is revoked from
PUBLIC/anon and granted to `authenticated` (it is evaluated inside RLS as the
querying role) + `service_role`. It is acknowledged in
`supabase/lint/advisors-allowlist.txt` for the same reason as `has_role`.
Like `has_role`, it answers only about `auth.uid()` unless the caller is the
service role — see the routable-is-not-answerable note under "Client grants".

### `calendar_series` — the repeat rule for an event

A calendar entry that repeats weekly. It is a template, not a thing members see:
the public surface is the dated `calendar_events` generated from it, which copy
its details including `visibility` and `invite_only`.

| Column             | Type          | Null | Notes                                                                        |
| ------------------ | ------------- | ---- | ---------------------------------------------------------------------------- |
| `id`               | `uuid` PK     | no   | `DEFAULT gen_random_uuid()`.                                                 |
| `title`            | `text`        | no   | The only required detail. e.g. "Beginner Gi".                                |
| `description`      | `text`        | yes  |                                                                              |
| `instructor_name`  | `text`        | yes  | Default instructor for generated dates.                                      |
| `location`         | `text`        | yes  | No column default. The add form pre-fills the club's gym; it can be cleared. |
| `visibility`       | `text`        | no   | `public\|members`. Default `public`. Copied onto every generated date.       |
| `invite_only`      | `boolean`     | no   | Default `false`. Access, and a badge. Copied onto every generated date.      |
| `weekday`          | `int`         | no   | `CHECK 0..6` (0 = Sunday, JS `getDay()`).                                    |
| `start_time`       | `time`        | no   | Local to the club (Australia/Sydney).                                        |
| `duration_minutes` | `int`         | no   | `CHECK > 0`.                                                                 |
| `starts_on`        | `date`        | no   | **Required.** First date the weekly session runs.                            |
| `ends_on`          | `date`        | yes  | **NULL = open-ended.** `CHECK ends_on >= starts_on`.                         |
| `is_active`        | `boolean`     | no   | Default `true`.                                                              |
| `created_by`       | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.                              |
| `created_at`       | `timestamptz` | no   | Default `now()`.                                                             |
| `updated_at`       | `timestamptz` | no   | Default `now()`; set app-side.                                               |

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
| `location`        | `text`        | yes  | No column default. The add form pre-fills the club's gym; it can be cleared.    |
| `starts_at`       | `timestamptz` | no   | Absolute instant (indexed).                                                     |
| `ends_at`         | `timestamptz` | no   | `CHECK ends_at >= starts_at`.                                                   |
| `status`          | `text`        | no   | `scheduled\|cancelled`. Default `scheduled` (cancel keeps the row).             |
| `visibility`      | `text`        | no   | **ACCESS.** `public\|members`. Default `public`; `members` = paid members only. |
| `invite_only`     | `boolean`     | no   | **ACCESS, and a badge.** Default `false`. Only invitees and managers see it.    |
| `created_by`      | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.                                 |
| `created_at`      | `timestamptz` | no   | Default `now()`.                                                                |
| `updated_at`      | `timestamptz` | no   | Default `now()`; set app-side.                                                  |

Partial unique index on `(series_id, starts_at) WHERE series_id IS NOT NULL`
keeps date generation idempotent. **RLS:** everyone (incl. anon) reads
`visibility = 'public'` that is not invite-only; a second policy adds `members`
events for callers where `has_active_paid_membership(auth.uid())` or
`has_role(auth.uid(),'manager')`, and lets a non-manager through an invite-only
date only when they have an RSVP row for it — policies are OR'd, so a paid member
sees both sets. Cancelled events stay readable so the cancellation shows.
Managers insert/update/delete.

Those policies call two helpers that live in the **`private`** schema, not
`public` (see "RLS-only helpers live in `private`" above):

**`private.event_is_invite_only(_event_id uuid) → boolean`** — SECURITY DEFINER
(`SET search_path = ''`): is this date invite-only, on its own row or inherited
from its series? It is SECURITY DEFINER because the policy has to read
`calendar_series`, which no client role may read directly. `anon` and
`authenticated` hold EXECUTE, since both read policies call it.

**`private.is_event_invitee(_event_id uuid, _user_id uuid) → boolean`** —
SECURITY DEFINER (`SET search_path = ''`): does an `event_rsvps` row exist for
this person and date? That is what unlocks an invite-only date for its invitees,
and it is SECURITY DEFINER so the check does not depend on the caller's own RLS
over `event_rsvps`. `authenticated` holds EXECUTE; `anon` does not.

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

## Blog

The public blog: posts written by managers only (finer-grained authoring
permissions are a later step), read by anyone. Any signed-in person may
comment or reply — membership status irrelevant, the same rule as calendar
RSVPs — and upvote a comment once (no downvote). Product spec:
**`docs/blog.md`**.

### `blog_posts`

| Column             | Type          | Null | Notes                                                                                                   |
| ------------------ | ------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| `id`               | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                                            |
| `slug`             | `text`        | no   | `UNIQUE`. Lowercase/hyphenated, 1–200 chars.                                                            |
| `title`            | `text`        | no   | 1–200 chars.                                                                                            |
| `excerpt`          | `text`        | yes  | ≤ 500 chars. Shown on the list page. Derived from `body_md` on save when left blank (`deriveExcerpt`).  |
| `body_md`          | `text`        | no   | 1–50,000 chars. Markdown; a `[[video:<url>]]` line embeds a video.                                      |
| `cover_image_path` | `text`        | yes  | Object path in the `blog-media` Storage bucket.                                                         |
| `status`           | `text`        | no   | `draft\|published`. Default `draft`.                                                                    |
| `author_id`        | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. The writing manager.                                    |
| `published_at`     | `timestamptz` | yes  | Set the first time `status` moves to `published`; never changed again — including on a later unpublish. |
| `created_at`       | `timestamptz` | no   | Default `now()`.                                                                                        |
| `updated_at`       | `timestamptz` | no   | Default `now()`; set app-side (no update triggers exist in this schema).                                |

Index on `(published_at DESC) WHERE status = 'published'` for the public list.

**RLS:** anyone reads published posts; managers read all. Writes run through
manager-only server functions on the service role (slug collisions, cover-image
cleanup on delete); the manager write policies are defence in depth, same idiom
as `event_rsvps`.

### `blog_comments`

| Column              | Type          | Null | Notes                                                               |
| ------------------- | ------------- | ---- | ------------------------------------------------------------------- |
| `id`                | `uuid` PK     | no   | Default `gen_random_uuid()`.                                        |
| `post_id`           | `uuid`        | no   | `REFERENCES blog_posts(id) ON DELETE CASCADE`.                      |
| `user_id`           | `uuid`        | no   | `REFERENCES auth.users(id) ON DELETE CASCADE`. The commenter.       |
| `parent_comment_id` | `uuid`        | yes  | `REFERENCES blog_comments(id) ON DELETE CASCADE`. NULL = top-level. |
| `body`              | `text`        | no   | 1–2000 chars. Plain text, no Markdown.                              |
| `status`            | `text`        | no   | `visible\|hidden`. Default `visible`.                               |
| `hidden_by`         | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Moderating manager. |
| `hidden_at`         | `timestamptz` | yes  |                                                                     |
| `hidden_reason`     | `text`        | yes  |                                                                     |
| `created_at`        | `timestamptz` | no   | Default `now()`.                                                    |
| `updated_at`        | `timestamptz` | no   | Default `now()`; set app-side.                                      |

Indexes on `(post_id, created_at)` and `(parent_comment_id)`.

**Reply nesting is one level.** A reply's own `parent_comment_id` must be
`NULL` — not something a `CHECK` constraint can express (it needs to read
another row), so it's enforced by the server function that inserts a reply,
the same way RSVP's "not to a cancelled event" rule is app-enforced rather
than a constraint.

**RLS:** anyone reads `visible` comments on a `published` post; a comment's
author can always read their own (even hidden, so moderation isn't silent to
them); managers read everything. Writes run through server functions
(`postComment` checks the blocked list, that a reply's parent is top-level,
and the honeypot; `setCommentVisibility` is manager-only) — no client write
grant. The insert policy still checks
`NOT private.is_commenter_blocked(auth.uid())` as defence in depth.

### `blog_comment_upvotes`

`(comment_id, user_id)` composite PK — one upvote per person per comment, no
downvote, toggled by insert/delete. `comment_id → blog_comments(id) ON DELETE
CASCADE`, `user_id → auth.users(id) ON DELETE CASCADE`, `created_at`.

**RLS:** a person reads/inserts/deletes only their own row. Totals shown on a
comment come from an aggregate query in the service-role comment-listing
function, not from reading other people's rows, so there's no public grant on
this table.

### `blog_blocked_commenters`

`user_id → auth.users(id) ON DELETE CASCADE` PK, `blocked_by → auth.users(id)
ON DELETE SET NULL`, `blocked_at`, `reason`. Existence of a row = blocked from
commenting anywhere on the blog — the extreme moderation action, separate from
hiding a single comment. **RLS:** manager-only; no client grants, so blocking
and unblocking (and the block check itself, via the `SECURITY DEFINER`
`is_commenter_blocked()` helper below) all run through the service role or a
function with a fixed search path.

**`private.is_commenter_blocked(_user_id uuid) → boolean`** — `SECURITY DEFINER`
SQL helper (`SET search_path = ''`), same shape as `has_role`/
`has_active_paid_membership`: lets the comment-insert RLS policy check block
status without granting `authenticated` a `SELECT` on
`blog_blocked_commenters` — an ordinary commenter has no business reading who
else is blocked. `authenticated` holds EXECUTE (the policy is evaluated as the
querying role); `anon` does not. It lives in the `private` schema, not `public`,
because no app code calls it by RPC — the block check in `postComment` reads
`blog_blocked_commenters` directly on the service role. See "RLS-only helpers
live in `private`" above.

### Storage: `blog-media`

A **public** bucket (unlike the private `waivers` bucket) for post images —
cover photos and inline photos. Videos are never uploaded; a post embeds one by
pasting a YouTube/Vimeo link. Object names are `<post id>/<filename>` (or
`drafts/<filename>` for an image uploaded before a new post has an id).
Migration `20260731120000_blog_storage.sql` owns the bucket's access model.

| Operation                  | Who                                                                          |
| -------------------------- | ---------------------------------------------------------------------------- |
| `SELECT`                   | no policy at all — the bucket itself is public, so reads bypass RLS entirely |
| `INSERT`/`UPDATE`/`DELETE` | managers only                                                                |

There is deliberately **no** `SELECT` policy: the bucket is public, so Storage
already serves any object's bytes by URL with no RLS involved, and a broad
"anyone can SELECT" policy would additionally let a client **list** the
bucket's contents via the API — exactly the `public_bucket_allows_listing`
advisor finding — which nothing in the app needs. The app always uploads
through the service role (`uploadBlogImage`), so the manager write policies
are defence in depth, same reasoning as the waiver PDF policies.

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

`key` PK, `value`, `updated_at`, `updated_by → auth.users(id)`. **RLS:**
manager-only. Keys in use:

| Key                              | Holds                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_payment_details`        | **JSON.** The club's bank account (account name, BSB, account number, bank, plus optional SWIFT/BIC and addresses, plus a note), shown field by field with a copy button each on `/membership` and in the payment email. Anything that is not a complete account parses as "not published yet". See `docs/memberships.md`. |
| `invoice_payment_instructions`   | **Legacy.** The free-text markdown that `invoice_payment_details` replaced. Nothing member-facing reads it; `/manager/settings` shows it read-only while the account fields are still empty. Pending deletion.                                                                                                             |
| `contact_messages_seen_at`       | ISO instant a manager last opened `/manager/contact-messages`. Club-wide, not per manager. Unset means nobody ever has, so every message counts unread.                                                                                                                                                                    |
| `interest_registrations_seen_at` | ISO instant of the newest interest registration on file when a manager last opened `/manager/users`. Same club-wide watermark shape; anything newer counts as a new sign-up on `/notifications`.                                                                                                                           |

Being key/value is what let the contact-message unread count, and later the
new-registration count, ship without a migration. It is also its limit: a value
here is a single club-wide fact, so anything that needs to differ per manager
needs a real table. Both watermarks are read and written through
`src/lib/seen-markers.ts`, which holds the only-moves-forward and
never-into-the-future guards.

### `email_verification_tokens` — proof that someone can read an address

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE` (**nullable**), `email`
(normalized, the address being proven), `purpose`
(`interest | waiver | manager_resend | self_resend | email_change | code_of_conduct`),
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

The `code_of_conduct` purpose is the one token that does a second job. It rides
on the "sign the code of conduct" link offered after a waiver and repeated in the
confirmation email, and it is how that page knows who is signing: the person is a
locked applicant at that point and cannot sign in at all. Opening it still proves
the address, like every other token here.

**RLS:** enabled with **no policies** and no client grants (`REVOKE ALL` from
anon/authenticated) — unlike `calendar_feed_tokens` there is nothing here a
person needs to see about their own row, so minting, redeeming and revoking all
run through the service role.

### `code_of_conduct_acceptances` — who agreed to the house rules

`id` PK, `user_id → profiles(user_id) ON DELETE CASCADE` (**not null**),
`version` (the document version agreed to), `accepted_at`, `full_name`, `email`
(both copied from the person's record by the server, as evidence),
`signature_name` (what they typed to sign), `signer_ip`, `signer_meta` (jsonb),
`created_at`. Index on `(user_id, accepted_at DESC)`.

The product spec is `docs/code-of-conduct.md`. Three things about the shape:

- **There is no template table.** The document lives in the repo
  (`src/lib/code-of-conduct.ts`) and `CODE_OF_CONDUCT_VERSION` is bumped by hand.
  House rules change by committee decision, and a git diff says more about what
  changed than a row would. An acceptance older than the current version reads as
  out of date, which is a prompt to re-read and never a block.
- **There is no PDF and no approval.** Nothing here gates anything: signing the
  code of conduct is not required before training, so there is no pending state
  and no manager decision to record. The text of each version is in git, so
  freezing a copy per acceptance would only duplicate it.
- **`user_id` is NOT NULL**, unlike `email_verification_tokens.user_id`. A
  verification token can exist before its person does; the code of conduct is
  only ever signed by somebody the club already holds, and signing it never
  creates a person.

Re-signing is always allowed and only ever adds a row, so the history of what
somebody agreed to and when stays intact.

**RLS:** enabled. Read policies for the owner and for managers as defence in
depth; no client grants (`REVOKE ALL` from anon/authenticated), so every read and
the insert run through the service role.

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

## Notifications

The `/notifications` page, the sidebar badge and the emails behind them. The
product spec is **`docs/notifications.md`**. Added by
`20260806030000_notifications.sql`.

One table drives both the in-app list and the email, which is why there is no
separate outbox: `read_at` is the in-app state and `emailed_at` is the delivery
state. The manager "needs attention" items are **not** stored here at all: they
are derived live from `membership_plans` by `sellableWindowNotifications`, and
clear by being fixed.

### `notifications`

| Column         | Type          | Null | Notes                                                                              |
| -------------- | ------------- | ---- | ---------------------------------------------------------------------------------- |
| `id`           | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                       |
| `user_id`      | `uuid`        | no   | `REFERENCES profiles(user_id) ON DELETE CASCADE`. The recipient.                   |
| `kind`         | `text`        | no   | `reply\|thread_activity\|new_blog_post\|blog_comment\|kb_comment`.                 |
| `subject_type` | `text`        | no   | `blog_comment\|kb_annotation\|blog_post`.                                          |
| `subject_id`   | `uuid`        | no   | What happened. **No FK**: it points at three tables, and must outlive its subject. |
| `actor_id`     | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Who did it.                        |
| `title`        | `text`        | no   | 1–200 chars. Frozen at write time.                                                 |
| `body`         | `text`        | yes  | ≤ 500 chars. A preview of the comment (`commentPreview`).                          |
| `href`         | `text`        | no   | Site-relative (`CHECK href LIKE '/%'`); the sender prefixes the origin.            |
| `read_at`      | `timestamptz` | yes  | NULL = unread. Drives the badge.                                                   |
| `emailed_at`   | `timestamptz` | yes  | NULL = not yet considered for email.                                               |
| `created_at`   | `timestamptz` | no   | Default `now()`.                                                                   |

`UNIQUE (user_id, kind, subject_id)`, plus indexes on `(user_id, created_at
DESC)`, a partial `(user_id) WHERE read_at IS NULL` for the badge, and a partial
`(created_at) WHERE emailed_at IS NULL` for the digest sweep.

**The unique index is the idempotency guard**, and it is why `blog_posts` needs
no `announced_at` column: a post unpublished and republished cannot produce a
second announcement, because the second insert collides. `published_at` could
not have carried that, since it is deliberately never cleared.

**Titles are frozen, not joined.** A notification is a record of a moment, the
same call `waivers` makes about its person fields. Rendering from a live join
would also mean every list read re-checks article visibility, and one missed
check leaks a members-only passage.

**RLS:** owner-scoped SELECT and UPDATE, with deliberately no manager policy —
the same call `kb_article_reads` makes. Reading other people's notifications
would be reading who replied to whom. No client grants, so every read and write
runs through a server function on the service role and
`client-grants-expected.txt` needs no entry.

### `notification_preferences`

`user_id → profiles(user_id) ON DELETE CASCADE` PK, four **nullable** booleans
(`reply_to_me`, `thread_activity`, `new_blog_post`, `manager_comment_alerts`),
`created_at`, `updated_at`.

**Nullable is the design, not an oversight.** NULL means "never chose" and hands
that switch to `NOTIFICATION_DEFAULTS` in `src/lib/notifications.ts`. A
`NOT NULL DEFAULT` could not express it: changing a club default later would
then move either nobody or everybody, including people who deliberately switched
it off. `manager_comment_alerts` is only consulted for somebody holding the
`manager` role, re-checked at send time rather than trusted from whenever the
row was written.

These govern **email only**. Every notification row is written regardless.

**RLS:** owner-scoped SELECT, defence in depth; no client grants.

### `notification_tokens`

`user_id → profiles(user_id) ON DELETE CASCADE` PK, `token` (raw, unique, **NOT
NULL**), `token_hash` (unique), `token_prefix`, `created_at`. Powers the
settings link in every email footer. That link is `/email-settings/<token>`,
which is an exchange rather than a page: it swaps the token for a short-lived
cookie and redirects to `/email-settings`. Nothing here expires, so an old
email stays exchangeable; the six-hour lifetime is on the cookie. See
`docs/notifications.md`.

The raw token is stored for the same reason `calendar_feed_tokens` stores one:
the server has to put this link into an email it composes later, which a one-way
hash cannot do. Unlike that table, `token` is NOT NULL here, because a row whose
raw token had gone missing would be a footer link that cannot be built.

**RLS:** enabled with **no policy at all**, deliberately. This is a credential
granting signed-out access to somebody's email settings; `authenticated` has no
grant and no reason to read even its own row, since the page it powers is
reached from a link rather than by looking the token up.

### The daily digest schedule (`pg_cron` + `pg_net` + Vault)

Added by `20260807000000_notification_digest_cron.sql`, which enables **pg_cron**
(schema `cron`) and **pg_net** (schema `net`) and registers one job,
`notification-digest`, at `0 20 * * *` UTC. It replaced a GitHub Actions
workflow: scheduling production work from CI put a credential that makes the site
email its members into a repo that takes same-repo branches from Lovable and from
coding agents.

**`private.run_notification_digest() → void`** — `SECURITY DEFINER`,
`SET search_path = ''`, `REVOKE ALL ... FROM PUBLIC`. The job names only this
function, never the token. The function reads both values from Supabase Vault and
`net.http_post`s to the endpoint.

Keeping the token out of `cron.job.command` is defence in depth rather than a
plugged hole: pg_cron 1.4+ puts RLS on `cron.job` with `USING (username =
current_user)`, so a command string is not world-readable. It is still the right
call. A credential in a column that exists to be read back and displayed is one
schema tweak or one superuser query away from being exposed, and there is no
upside to inlining it.

This **widens** the `private` convention. That section is written as "RLS-only
helpers live in `private`", and this helper's only caller is pg_cron, not a
policy. The rule it actually follows is the more general one that section rests
on: `private` is not routable by PostgREST, so nothing there is reachable as an
RPC. A function that makes the site email every member belongs on that side of
the line whether a policy calls it or not.

Two things that fail silently every morning rather than loudly once:

- Read **`vault.decrypted_secrets.decrypted_secret`**, never
  `vault.secrets.secret` — the latter is ciphertext, and sending it as a bearer
  token earns a 401.
- Point at the **`jitsu.au`** origin, not the published `*.lovable.app` host:
  that one 302s, and pg_net does not follow redirects.

The migration deliberately **does not arm the job**. It fires nightly and returns
immediately with a `RAISE WARNING` until both secrets exist:

```sql
SELECT vault.create_secret(
  'https://jitsu.au/api/notifications/digest', 'notification_digest_url');
SELECT vault.create_secret('<same value as NOTIFICATION_DIGEST_KEY>',
  'notification_digest_key');
```

---

## Knowledge base

Versioned markdown pages members read and annotate, served at `/kb/<slug>`,
grouped into ordered sections. **Signed-in only.** The product spec is
**`docs/knowledge-base.md`**. Added by `20260731140000_documents.sql`, renamed and
extended by `20260802100000_knowledge_base.sql`, and narrowed to members-only
(plus reading progress) by
`20260802160000_kb_members_only_and_reading_progress.sql`.

### `kb_sections` — the groups, and the reading order

`id` PK, `slug` (**unique**, lowercase kebab-case), `title`, `position` (lower
sorts first), `created_at`, `updated_at`.

A section holds no text and no secrets: it is a heading and a number. What makes
it load-bearing is that `(section.position, article.position)` is the **only**
source of the sidebar order, the index page and the previous/next links, so it
is the path a new member reads through. Seeded as 10/20/30 so a section can be
slotted between two others without renumbering.

### `kb_articles` — an article's identity, and where it sits

`id` PK, `slug` (**unique**, CHECK'd to lowercase kebab-case so it never needs
escaping in a URL), `visibility` (`members | managers`, default `members`),
`annotations_enabled` (default true), `section_id → kb_sections(id)
ON DELETE SET NULL`, `position`, `nav_title`, `link_path`, `created_at`,
`updated_at`, `created_by → auth.users(id) ON DELETE SET NULL`. Index on
`(section_id, position)`.

Nothing here is rewritten when the text changes: a slug is a permanent URL, and
the text lives on the versions below.

**`visibility` decides which SIGNED-IN people, not whether a login is needed.**
There is no `public` level: `canReadArticle` (`src/lib/kb.ts`) refuses a viewer
with no user id every article, whatever it says, and the route gate on `/kb`
redirects them to `/auth` first. The CHECK was narrowed to two values in
`20260802160000`, which also moved the rows that were `public` (the two seeded
link entries) to `members`. The gate is enforced **in the server functions**, not
by RLS — see the RLS note at the end of this section.

Two columns are easy to miss:

- **`link_path` makes the row a LINK ENTRY, not an article.** It is a sidebar
  item pointing at a page elsewhere on this site (`/first-class`, `/faq`), so it
  has no versions, renders no reader page, and takes no comments. It exists so
  the knowledge base can put the club's existing public pages in the reading
  order rather than re-telling them. A CHECK confines it to site-relative paths
  (one leading slash, then alphanumeric, and no `//`), which is what stops it
  becoming an open redirect or an arbitrary destination in the club's own nav.
- **`nav_title` is the sidebar label**, falling back to the live version's
  title. `kb_articles_link_entry_is_named` requires one on a link entry, which
  has no version to borrow a title from.

`ON DELETE SET NULL` on `section_id` is deliberate: deleting a section is a
tidy-up of the navigation and must never take the club's articles with it. They
fall into the "Everything else" group instead, which is visible and recoverable.

**The other half of "a link entry has no body" is enforced in code, not here.**
A CHECK cannot see another table, so `saveKbArticle` is what refuses to give a
link entry text, and refuses to turn an article that already has versions into a
link. Same precedent as one-level-deep replies below.

### `kb_article_versions` — the text, one row per save

`id` PK, `article_id → kb_articles(id) ON DELETE CASCADE`, `version` (**per
article**, starting at 1), `title`, `body_md` (up to 200k), `change_note`,
`is_current`, `created_at`, `created_by`. `UNIQUE (article_id, version)`, plus a
**partial unique index** `kb_article_versions_one_current_per_article` on
`(article_id) WHERE is_current` — exactly one live version per article.

Saving always writes a NEW row and promotes it, exactly like `waiver_templates`,
so history is intact and an annotation can name the wording it was written
against. The partial index makes promotion necessarily demote-then-promote;
`promoteArticleVersion` (`src/lib/kb-admin.ts`) orders those two writes so a
failure leaves the previous version live rather than leaving the article with
none — and, unlike the waiver's global equivalent, **every write is scoped to one
`article_id`**, since an unscoped clear would unpublish every other article.

A save that carries neither `title` nor `body_md` writes no version at all. That
is how "move this article into Start here" is a placement change rather than a
republish that would show every reader "updated today".

**History is a manager's view.** Every member-facing read filters
`is_current = true`, and the one call that returns the list of versions,
`listArticleVersions`, is manager-gated — so a superseded wording, a
`change_note`, and the transient non-current row a save writes before promoting
it are all manager-only. `20260807010000_kb_versions_current_only.sql` restates
the signed-in RLS policy to match (`is_current` plus the parent article being
`members`); "Managers can read all article versions" is unchanged and is the only
route to the rest. As with every policy on these tables this is defence in depth
— `anon` and `authenticated` hold no grant here — and it carries the
co-requisite from `20260731140000`: the policy sub-selects `kb_articles`, which
the caller cannot read, so a future client grant on the versions table alone
would make it error rather than deny.

### `kb_article_reads` — how far along the path a member is

`user_id → profiles(user_id) ON DELETE CASCADE`, `article_id → kb_articles(id)
ON DELETE CASCADE`, `version` (which version they read), `read_at`, with
`PRIMARY KEY (user_id, article_id)`.

One row per person per article, **overwritten on a re-read**: this is "when did
you last read it", not a log. Reading is a state a member glances at, not an
audit trail, and a row per view of a syllabus somebody keeps open would dwarf
every other table here. The composite PK leads with `user_id`, which is also the
only query ("everything this person has read"), so no second index is needed.

`version` is why the sidebar can say **"updated since you read it"** rather than
leaving an article ticked off after it was rewritten. It is a plain integer and
not a foreign key, for the same reason `kb_annotations.article_version` is one:
it records what was on screen, not a live join.

**RLS is owner-scoped in both directions, and there is deliberately no manager
policy.** What a member has and has not read is theirs; no manager screen and no
agent action reads this table. Same call the feature already makes about private
notes.

### `kb_annotations` — private notes and shared comment threads

`id` PK, `article_id → kb_articles(id) ON DELETE CASCADE`, `article_version`
(a plain integer, like `waivers.template_version` — not a FK), `user_id →
profiles(user_id) ON DELETE CASCADE` (**not null**: there is no anonymous
commenting), `block_id`, `quote`, `visibility` (`private | shared`), `parent_id →
kb_annotations(id) ON DELETE CASCADE`, `body`, `resolved_at`, `resolved_by`,
`created_at`, `updated_at`. Indexes on `(article_id, created_at)`, `(user_id,
created_at DESC)`, and a partial one on `parent_id`.

Three things about the shape:

- **Anchoring is content-derived, not positional.** `block_id` is a hash of the
  block's own text (`blockId` in `src/lib/kb.ts`), so inserting a paragraph does
  not move every annotation below it onto the wrong passage. `quote` is the
  fallback anchor and the honesty mechanism: when neither matches, the
  annotation is reported as being about wording that has since changed rather
  than silently re-pointed.
- **`visibility` is the whole privacy model.** A `private` note is readable only
  by its author — **managers included**. That is deliberate and is what makes a
  private note usable; `list_kb_comments` on the manager agent API returns
  shared threads only.
- **Threads are one level deep.** The CHECK
  `kb_annotations_private_has_no_parent` catches the half a constraint can see (a
  private row with a parent); `createAnnotation` enforces the rest (no replying
  to a private note, no replies to replies, and no private reply), since a CHECK
  cannot read the parent row.
- **Deleting a profile deletes other people's replies.** `user_id` and
  `parent_id` both cascade, so removing one person takes their thread roots and,
  with them, everybody else's replies to those threads. The `parent_id` cascade
  is wanted (deleting an abusive root should take the conversation); this
  second-order effect is the price, and unlike the in-app delete there is no
  warning in front of it. Worth knowing before deleting a profile.

**Readers never choose a version.** `visibility` lives on the article, not on
each version, so serving an arbitrary version to a reader would publish an
article's whole drafting history the moment it goes live. The public read
(`readKbArticleSchema`) has no `version` parameter at all; only the manager agent
API can name one.

**RLS:** enabled on all five, with owner/manager read policies as **defence in
depth only** — there are no client grants (`REVOKE ALL` from anon/authenticated),
so nothing here is reachable from a browser and `client-grants-expected.txt`
needs no entry. Every read and write runs through a server function on the
service role, which enforces visibility in code.

## Public intake (anon insert-only)

### `interest_registrations`

`id` PK, `name`, `email`, `phone`, `uts_student`, `experience`, `message`,
`sms_whatsapp_consent`, `client_submission_id`, `created_at`. **RLS:** anon
INSERT under a validating `WITH CHECK` (name/email/phone/experience/message
length + email format). Each row is a **lead**: kept exactly as submitted,
creating no person record. The manager directory merges leads in by normalized
email until the email belongs to a person (they signed the waiver).

A manager can **delete a lead** from `/manager/users` (`deleteLead`), which
removes every registration under that address, since the directory merges them
into one row. Refused, on the server, when the address belongs to a person: they
have signed something, and their enquiry is part of that record. This is the
only erasure the product has, and why it stops here is
`docs/erasing-personal-data.md`.

### `contact_messages`

`id` PK, `name`, `email`, `subject`, `message`, `client_submission_id`,
`created_at`. **RLS:** anon INSERT under a validating `WITH CHECK`.

Insert-only for both client roles, and it stays that way: managers read it
through `listContactMessages` (`src/lib/contact-messages.functions.ts`) on the
**service-role** client behind the manager gate, so `/manager/contact-messages`
needed no read grant, no new policy and no migration. The same is true of
`deleteContactMessage`, which removes one message for good: there is no copy
elsewhere in the product, so a manager confirms what goes before it goes (see
`docs/erasing-personal-data.md`).

Submitting also emails the sender an acknowledgement and every manager the
message itself (`src/lib/contact-email.server.ts`, best-effort: a send failure
is logged and never fails the submission). Before that existed nothing sent an
email and nothing on the site read this table, so a message reached nobody at
all.

Which messages are "unread" is a single club-wide marker, not a column here:
`club_settings.contact_messages_seen_at`, stamped when a manager opens the
inbox. Anything newer than it is counted onto the manager dashboard. A
per-manager count would need a table of its own; the club shares one inbox and
every manager is emailed every message, so it does not have one.

Being one watermark ("everything up to here has been seen") is what makes it
free, and also its one sharp edge: it can only be moved when the list that
acknowledges it reaches all the way back to it. `listContactMessages` therefore
returns `newestAt: null` when its own `limit` truncated the result, and the
screen says so — otherwise showing the newest 200 of 250 would mark the 50 it
never rendered as read. Paging that screen is the real fix if the club ever
needs it.

### `client_submission_id` (all three intake paths)

A nullable `uuid` on `interest_registrations`, `contact_messages` and `waivers`,
each behind a **partial unique index** (`WHERE client_submission_id IS NOT NULL`,
so the pre-existing NULL rows stay legal). Added by
`20260729020000_submission_idempotency.sql`.

The browser mints one per form fill and resends it unchanged on every retry. It
exists because the public forms now retry hard through a bad connection:
**aborting a request client-side does not stop the server**, so an automatic
retry can race a first attempt that is still committing. Without a key to
recognise, that is a duplicate lead, or a duplicate signed waiver plus a second
round of emails to the member and every manager.

How each path detects a repeat differs, and it follows from the grants:

- `interest_registrations` / `contact_messages` are written **as `anon`**, which
  holds `INSERT` and deliberately no `SELECT`. They cannot look first, so they
  read the unique violation (SQLSTATE `23505`) as "already recorded", return
  `ok`, and **skip the emails**.
- `waivers` is written with the **service role**, so `submitWaiverWithPdf` looks
  the id up before doing any work and returns the existing row. The same read
  backs `checkWaiverSubmission`, the endpoint a signer's browser calls to ask
  whether a submission whose reply was lost actually landed.

Nullable on purpose: a client cached from before this shipped sends nothing and
must still be able to submit. It simply gets no dedupe protection, which is the
behaviour it already had.

---

## `auth.users` (Supabase-managed)

The person's one identity record, managed by Supabase Auth (not in our
migrations) — **the only place any email lives**. An applicant's auth user is
created **locked** (banned, no credentials) by waiver submission; approval
lifts the ban. There is no self-serve sign-up (`docs/waivers.md`, rules 6 and
9). Two triggers fire:

- `handle_new_user_role` — grants `manager` to a confirmed whitelisted address.
- `ensure_profile` — inserts the `profiles` row for every new auth user, with a
  seeded `first_name` (the auth user's metadata name, else `Member`).
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
