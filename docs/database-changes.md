# Changing the database

**Read this before you touch `supabase/migrations/**`, a table, an RLS policy,
or a grant.** It is deliberately kept out of `CLAUDE.md` so it is not loaded on
every session, but the rules here are not optional: two of them exist because
production broke, and a third because it nearly did.

`docs/database.md` is the schema _reference_ (every table, column, policy and
grant). This document is the _procedure_ for changing it.

The short version:

1. **Committing a migration does not apply it.** Nothing in the pipeline runs
   these files against the live database.
2. **Do not apply SQL before the user has approved the PR.** There is one
   database and no staging tier.
3. **`GRANT` cannot narrow a privilege — only `REVOKE` can.** Every new table
   arrives fully open to `anon` and `authenticated`.
4. **Additive schema goes live before the code that needs it; destructive schema
   goes live after the code that stopped using it.**

---

## Table grants: only REVOKE narrows, and RLS is the second lock

Supabase's bootstrap runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL
ON TABLES TO anon, authenticated, service_role`, so **every new table arrives
with all eight privileges** (SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
REFERENCES, TRIGGER, MAINTAIN) granted to both client roles.

> [!IMPORTANT]
> **`GRANT` only ever adds — it cannot narrow.** `GRANT SELECT ON t TO
authenticated` meaning "reads only" grants a privilege the role already holds:
> it reads like a restriction in review and does nothing. A new table needs an
> explicit `REVOKE ALL ON public.<t> FROM anon, authenticated;` **before** any
> intended grant. Every table in this schema was fully open to both client roles
> until `20260728120000` and `20260728150000` revoked them.

The full picture, including the complete list of privileges the client roles are
allowed to hold, is the "Client grants" section of **`docs/database.md`**. Read
it before writing a migration that touches grants. Three things bite repeatedly:

- **"Server function" does not mean "service role".** Several `*.functions.ts`
  handlers build their own client from `SUPABASE_PUBLISHABLE_KEY` with no user
  session, so PostgREST resolves them to `anon` and their queries need real
  grants — that is the whole public funnel (interest form, contact form, waiver
  signing page, pricing page). Grepping imports of
  `@/integrations/supabase/client` will not find them: **grep `createClient`
  too**, and check which key each one passes.
- **An RLS policy that references another table needs a grant on that table.**
  Policy expressions run with the _caller's_ privileges, so the `storage.objects`
  policy that sub-selects `public.waivers` fails with `permission denied` unless
  `authenticated` holds `SELECT` there. Route it through a `SECURITY DEFINER`
  helper (as the manager branch does with `has_role()`) if you do not want the
  grant.
- **A write grant makes "defence in depth" policies real.** Owner-scoped write
  policies written on the assumption that no client grant exists become live,
  reachable paths the moment one does, bypassing rules that only live in the
  server functions.

`supabase/lint/client-grants-expected.txt` pins the allowed set and
`.github/workflows/migration-drift.yml` checks it against the live ACL. When you
add a table or a grant, update that file in the same change or the check fails.
Read the live ACL from **`pg_class.relacl`**, never
`information_schema.role_table_grants`: the information_schema views only show
grants the connecting role is party to (a least-privilege reader sees an empty
set) and they omit `MAINTAIN` entirely.

## Schema drift: committing a migration does NOT apply it

> [!IMPORTANT]
> **Nothing in this pipeline runs `supabase/migrations/*.sql` against the live
> database.** Writing a migration file and pushing it changes nothing about
> production. Lovable applies only the SQL **its own agent** writes, and records
> it in the live `supabase_migrations.schema_migrations` ledger. A migration
> that arrives via a GitHub push is inert until somebody applies it by hand.
>
> The "against the live database" qualifier matters:
> `.github/workflows/supabase-lint.yml` _does_ replay every migration, but onto
> a throwaway local Postgres. That proves a migration **can** apply; it says
> nothing about whether it **has**.

There is **one database** — no staging or preview tier. The Lovable editor
preview, the published `.lovable.app` site and the deployed site all read the
same Supabase project (`supabase/config.toml` → `project_id`). So an unapplied
migration is a production outage waiting for the first request that needs it,
and applying one is a production change.

This is not hypothetical. On 2026-07-28 the live `waivers` table had no
`approval_status` column — every manager approval failed with
`column waivers.approval_status does not exist` — while
`20260721120000_waiver_approval.sql` sat merged in this repo. Of the 28
migration files, **13 had no ledger row at all, and 3 of those had never
reached the live schema by any route** (the waiver approval columns, the
template acknowledgements column, and the role-security hardening). The other
10 were live despite the missing ledger row, because a later Lovable prompt had
its agent author and apply equivalent SQL for the same feature, then emit that
as a migration of its own — which is also where the duplicate migrations below
come from.

**The rule: a migration is not done until it is live — but a human sees the SQL
before it touches production.** There is one database and no staging tier, so
applying a migration _is_ a production change and gets a review gate like any
other. Sequence, in order:

1. Write the migration file, push the branch, and **open the PR. Stop there.**
   Do **not** run any of it against the live database yet. Say plainly in the PR
   body what SQL is waiting to be applied and what it changes, so the reviewer is
   approving the schema change and not just the diff.
2. **Wait for the user to approve the PR.** This is a blocking gate: no live SQL
   without it, additive or not. If CI needs the schema to be live to pass, say so
   in the PR and wait — do not apply it to get a green tick.
3. Once approved, apply the SQL against the live database (the Lovable project's
   SQL access).
4. Record it in the ledger so it is not later re-derived as a duplicate:
   `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)`
   with `version` = the file's timestamp prefix, `name` = the rest of the stem.
5. Verify the object actually exists (`information_schema.columns`, `pg_proc`,
   `pg_policies`, `information_schema.role_table_grants`) and reload PostgREST:
   `NOTIFY pgrst, 'reload schema'`.
6. Merge — and only then merge code that depends on it (see sequencing, below).

The gate is the approval, not the merge: applying between steps 2 and 6 is what
keeps a migration from sitting merged-but-inert, which is the failure this whole
section exists to prevent. Never merge a migration you have not applied.

Approval of the PR covers the SQL described in it, and nothing else. Widening the
change after approval (another table, another column, a `DROP` you noticed on the
way) means updating the PR and asking again.

**How drift gets caught now** (both are backstops, not substitutes for the rule):

- `supabase/lint/check-migration-drift.py`, run by
  `.github/workflows/migration-drift.yml` on pushes to `main`, on a daily
  schedule, and on demand. It compares `supabase/migrations/*.sql` against the
  live ledger and fails when a file has no matching row. Contract-phase
  migrations that must land _after_ a deploy go in
  `supabase/lint/migration-drift-allowlist.txt` with a note.
  - It **does not run on pull requests, by design** — it holds a production
    credential, and a same-repo PR branch (how Lovable and every agent push
    here) would receive that secret while running a script the PR itself can
    edit. So drift surfaces a merge later, not in the PR. Only the checker's
    `--selftest` runs on PRs, from `ci.yml`.
  - Without the `SUPABASE_DB_URL` secret it warns and passes, so a green tick
    only means "no drift" once the secret is set — the job summary says which.
  - It proves a **ledger row exists**, not that the SQL ran. Since step 4 above
    writes that row by hand, a recorded-but-unapplied migration still passes.
    Step 5 (verify the object exists) is the part only a human/agent can do.
- `bun run typecheck`. `src/integrations/supabase/types.ts` is generated **from
  the live schema**, so it is the closest thing the repo has to a mirror of the
  real database. Every row type now derives from it, and
  `src/integrations/supabase/schema-contract.test.ts` pins the columns the app
  depends on. This lags — the types only change when Lovable regenerates them,
  or when someone hand-adds a verified column (see "Supabase clients" in
  `CLAUDE.md`)
  — so treat it as a second net, not the first.

⚠️ **Never hand-write a row type that asserts a column into existence.**
`profile-types.ts` declared its own `WaiverRow`/`ProfileRow` (and
`membership-types.ts` its own `ManagerApiTokenRow`) and layered them over the
generated `Database`. That is one of the two reasons `approval_status` could be
missing from production for a week with a green build — the hand-written type
told the compiler the column was there; the other is that nothing ran `tsc` in
CI at all. Alias the generated types (`Database["public"]["Tables"][…]["Row"]`)
and let a real mismatch fail the typecheck. Same for `as never` /
`as unknown as` casts on a query — they silence the one check that would have
caught this.

The one sanctioned exception is hand-adding a column to `types.ts` itself,
after verifying it exists live — see "Supabase clients" in `CLAUDE.md`. That is the
same assertion in a different file, so it is only safe because the SQL was
applied and checked first.

## Sequencing schema changes and the code that depends on them

The database and the app deploy through **different paths** — a migration only
reaches Cloud when it is applied (see above), while the app code ships with the
branch — so the two can drift. Merged code that calls a new RPC
or reads a new column **before the migration is live** fails at runtime with
errors like `Could not find the function public.user_id_by_email in the schema
cache`, or a missing-column error. Sequence the two using **expand/contract**
(parallel change), and prefer **separate PRs** so a human gate sits between the
schema change **merging** and the code that depends on it merging.

Under the rule above, that gate now sits **before** the live schema change, not
just before the file's merge: the reviewer approves the migration PR, and only
then does the SQL run against production. So the schema PR's approval is the
point at which to catch a bad `DROP`, a mis-scoped `REVOKE`, or a column the code
does not actually need — after it there is no staging tier to absorb the mistake.

- **Additive schema the new code needs** (new tables, columns, functions):
  land the **migration first, in its own PR**. Confirm it is applied to the live
  DB and the PostgREST schema cache is reloaded (`NOTIFY pgrst, 'reload schema'`),
  and that the new object actually exists, **then** merge the code PR that uses
  it. Additive changes are backward compatible, so the currently-deployed old
  code keeps working in the gap. This is the "DB change first, code second" rule
  — and it only holds for additive changes.
- **Destructive schema** (drop/rename a column, `TRUNCATE`, remove a function):
  the **opposite** order. Ship and deploy the code that stops using the old shape
  first, then merge a migration that removes it. Never drop or rename something
  the currently-live code still reads — that breaks it in the window before the
  new code deploys.
- A migration that **both adds and drops** (a table reshape — e.g. the profiles
  migration that created `user_id_by_email` _and_ dropped `waivers` columns and
  `TRUNCATE`d) is really two phases. Split it: the additive expand phase goes
  live before the code, the destructive contract phase after.
- Keep each migration backward compatible within a single deploy step where you
  can (add-then-backfill-then-switch rather than rename-in-place). Keep
  `docs/database.md` aligned in the **code** PR that introduces the usage.

Note: the unit suite never sees a live DB, and `bun run build` is Rollup-only
(no type-check). The migration-drift workflow catches an _unapplied_ migration
(but only after merge, and only once its secret is set), and `bun run typecheck`
catches code that reads a column the generated types don't have — but neither
sees a preview-only bundler-interop fault, and neither can prove the ordering
above was respected. Sequencing and a browser/DB smoke check are still the real
guards.

## Lovable can re-emit a hand-written migration as a duplicate

Lovable generates migrations from the **live database's schema**, not from this
directory's history, so it does not know that a hand-written migration already
creates an object. A "Rebuilt schema cache" edit can therefore drop a second
migration here that re-creates what an earlier one already made. That is what
happened in issue #53: `20260725021949_…` was a verbatim copy of
`20260723000000_profiles.sql`, and the duplicate `CREATE TABLE public.profiles`
broke the from-scratch replay (`relation "profiles" already exists`, 42P07), so
the Supabase lint workflow could not run on any PR.

- The symptom is the **Advisors + plpgsql_check** job failing on every
  `supabase/**` PR, including ones whose own SQL is fine. A red ❌ there says
  nothing about that PR until the replay itself is green again.
- After Lovable syncs a schema change, it is worth checking that the new
  migration is not a re-derivation of one already in this directory.
- When it is a pure duplicate, empty the later file to a no-op with a comment
  explaining why (see `20260725021949_…`). **Keep the file** so the applied
  migration ledger stays intact, and do not delete it. Making only the first
  statement idempotent is not a fix: every later statement collides too, and an
  in-place `RENAME COLUMN` has nothing left to rename on replay.
- Prefer `DROP … IF EXISTS` before a deliberate re-create (see
  `on_auth_user_created_assign_role` in `20260721091500_…`), which is what makes
  a genuine re-point replay cleanly.
