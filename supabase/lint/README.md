# Supabase lint (CI)

`.github/workflows/supabase-lint.yml` starts a throwaway local Postgres with
`supabase db start` (which applies every migration in `../migrations`) and runs
both Supabase linters against it, plus the **client grants** check below. It is
path-filtered to `supabase/**`, so frontend-only PRs don't pay for a Docker
database.

This directory also holds two checks that talk to the **live** database rather
than a local one: **migration drift** and **client grants**. Neither runs in CI,
because on this project CI cannot reach the live database at all — see "Why
these two are run by hand".

`check-client-grants.py` therefore has two jobs. Against the **live** ACL it is
one of those by-hand checks. Against the **local replay** the workflow already
builds, it needs no credential at all, so that half of it does run in CI — see
"One checker, two databases".

## What runs

| Check                      | Tool                                                            | Catches                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Advisors**               | `splinter.sql` via `psql` → `check-advisors.py`                 | The Security/Performance lints from the dashboard's **Database > Advisors**, e.g. `function_search_path_mutable` (a `SECURITY DEFINER` function without a fixed `search_path`).                                  |
| **plpgsql_check**          | `supabase db lint --schema public --fail-on warning`            | Errors in `public` PL/pgSQL function bodies (unused variables, bad SQL, etc.).                                                                                                                                   |
| **Client grants (replay)** | `check-client-grants.py` against the replayed `pg_class.relacl` | A table the migrations leave open to `anon`/`authenticated`. Supabase grants ALL on every new table and `GRANT` cannot narrow that, so a missing `REVOKE` replays fully open. Runs in CI — no credential needed. |
| **Migration drift**        | `check-migration-drift.py` against the live ledger              | A migration file that has never been applied to the live database. Committing a migration does not apply it — see `docs/database-changes.md`. **Run by hand**, not in CI.                                        |
| **Client grants (live)**   | `check-client-grants.py` against the live ACLs                  | A privilege `anon` or `authenticated` holds that `client-grants-expected.txt` does not list, or one it lists that is missing. **Run by hand**, not in CI.                                                        |

`supabase db lint` is scoped to `public` on purpose: Supabase-managed schemas
(`storage`, `auth`, …) ship functions that emit warnings we don't control.

## One checker, two databases

`check-client-grants.py` is pointed at two different databases, over the same
query and the same `client-grants-expected.txt`, and the two runs answer
different questions:

- Against the **local replay** in `supabase-lint.yml`: do the migration files,
  applied from nothing, produce the expected set? The replay is a throwaway
  container the workflow already starts, so this needs no credential and none of
  the reachability problems below apply. It runs on every `supabase/**` pull
  request, which is where a table that forgot its `REVOKE` is cheapest to fix.
- Against the **live database**, by hand: does production hold the expected set
  today? Only somebody with Lovable's SQL access can answer that, so it is a
  snapshot taken deliberately rather than a check that runs.

Neither subsumes the other. The migrations can be right while production has
drifted by hand, or production can be right while the migrations would replay
open — and the second is the one nobody notices, because every database built
from this directory alone (the CI stacks, a restore, a re-provision, a clone
once the repo is public) gets it. The replay half is also the only one of the
two that anything runs automatically, so treat a by-hand live run as the thing
that catches drift the replay cannot see, not as a duplicate of it.

Two things to know before reading a failure:

- **Grants follow the object, not the name.** A `REVOKE` survives a later
  `ALTER TABLE … RENAME TO`, so the migration that closes a table may name it
  something else entirely: `kb_articles`, `kb_article_versions` and
  `kb_annotations` are closed by `20260731140000_documents.sql`, under the names
  they had before the knowledge base rename. Grepping the migrations for a
  table's current name therefore reports a missing `REVOKE` that is not missing.
  Replaying and reading the ACL is the only reliable check, which is why this
  runs as a replay rather than as a lint over the files.
- **The replay is Postgres's answer, not a re-reading of the SQL.** If it says a
  table is open, it is open in every database built from these files.

## Migration drift

The local replay above proves a migration _can_ apply; it says nothing about
whether it _has_. Nothing in this pipeline runs `../migrations/*.sql` against
the real database, so `check-migration-drift.py` reads
`supabase_migrations.schema_migrations` from the live project and compares it to
the files on disk.

### Why these two are run by hand

There is no workflow for them. There was one until 2026-08-22
(`migration-drift.yml`), and it never checked anything: it needed a
`SUPABASE_DB_URL` secret that cannot exist for this project. Two independent
reasons, both confirmed on 2026-08-22:

- **Lovable Cloud does not expose the credential.** The Supabase database
  password and connection string are held by Lovable and kept out of the project
  UI. The database is reachable from the app code, from server functions and
  through Lovable's own SQL access, but the connection string cannot be copied
  out, so there is nothing to put in a GitHub secret.
- **The database is IPv6-only.** `inet_server_addr()` reports a `2406:da18:…`
  address and GitHub-hosted runners are IPv4-only. Even given a connection
  string, a runner could not open the socket.

The workflow's guards were changed on 2026-08-21 to fail rather than pass when
the secret was missing, because a green tick that meant "the job started" is
worse than no check at all. Once it was clear the secret could never be set, a
permanently red job was no better, so the workflow went. The checkers themselves
work fine; they just need somebody to feed them the query output.

**Do not add a workflow back** without first establishing that a reachable
credential exists. If Lovable ever exposes one, note why the old workflow
deliberately never ran on `pull_request`: this repo takes **same-repo** feature
branches from Lovable and from coding agents, and GitHub withholds secrets from
fork PRs but **not** from same-repo branch PRs, so a PR-triggered job would hand
a production credential to a script the same PR is allowed to rewrite. That
constraint has not changed.

### Running them

Get the CSV out of the live database through Lovable's SQL access, save it, and
run the checker against it. Neither script touches a database itself.

Migration drift:

```sql
SELECT version, coalesce(name, '')
  FROM supabase_migrations.schema_migrations
 ORDER BY version;
```

```sh
python3 supabase/lint/check-migration-drift.py applied.csv
```

Client grants — this reads `pg_class.relacl`, **not**
`information_schema.role_table_grants`. The information_schema views only show
grants where the current user is the grantor, the grantee, or a member of the
grantee role, so a restricted reader sees nothing there and the check would come
back empty and pass while the schema was wide open. `pg_class` and `pg_roles`
are world-readable, so `aclexplode()` gives the true ACL whatever role connects.

```sql
SELECT c.relname, r.rolname, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND r.rolname IN ('anon', 'authenticated')
 ORDER BY 1, 2, 3;
```

```sh
python3 supabase/lint/check-client-grants.py grants.csv
```

Worth doing after a migration is applied, before a release, and any time someone
has changed a grant or a policy by hand in the Lovable UI. That last one
produces no commit and no signal, and is exactly the drift these catch.

**Migration drift last run: 2026-09-04.** 76 migration files, **2 reported
unapplied** — the two below. Both were then allowlisted as already-live
re-emissions, so the next run reports **0 unapplied** and lists them under
"Allowlisted, so not counted above" instead.
**Client grants last run: 2026-09-01**, straight after applying
`20260828000000_waiver_pdf_guardian_read.sql`: 18 live, 18 expected, 0
unexpected. The one ledger row with no file here (`20260722131547`) is the known
duplicate re-emission described in `docs/database-changes.md`, not missing
schema.

⚠️ **The two that report as unapplied are NOT drift, and one of them must never
be applied.** This file said the opposite from 2026-09-01 until 2026-09-04, when
the live objects were read instead of the SQL. Both changes are already in
production, re-emitted by Lovable under filenames of its own. That is the same
CAUSE as the ledger row above and the opposite SYMPTOM: there, a row with no
file (an orphan, reported as a note, never fatal); here, a file whose ledger row
is under the re-emission's version, so the original reports as unapplied:

- `20260821000000_notification_digest_fails_loudly.sql` — **superseded. Applying
  it would stop the digest.** The RAISE it introduced is live, carried into
  `20260822120041` (the function's third body, applied 2026-08-22). Re-applying
  this file installs the _second_ body, which reads a `notification_digest_url`
  Vault secret that `20260822120041` retired in favour of an inlined jitsu.au
  URL. `vault.secrets` holds only `notification_digest_key`, so the job would
  raise nightly and nobody would be emailed again.

  ```sql
  -- What proved it: RAISE EXCEPTION present, no RAISE WARNING, URL inlined.
  SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname = 'run_notification_digest';
  SELECT name FROM vault.secrets WHERE name LIKE 'notification_digest%';
  ```

- `20260823000000_notification_digest_morning_schedule.sql` — live via
  `20260823002504`, which carries the same executable statements (Lovable's
  re-emission strips the commentary, so the files are 2819 and 576 bytes; the
  SQL matches once comments are removed, the prose does not). Applying it would
  be a harmless no-op, but it is not drift either.

  ```sql
  -- What proved it: '0 22 * * *', active, and a send that lands on it.
  SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'notification-digest';
  SELECT max(emailed_at) FROM public.notifications;  -- 2026-09-02 22:00:06+00
  ```

**The general lesson, which is why this is written up rather than quietly
fixed:** this check compares identities, not content (it is the fourth entry
under "Known blind spots" below), so a file with no ledger row raises a
question. It does not answer it. Read the
object — `pg_proc.prosrc`, `cron.job`, `information_schema` — before applying
anything on the strength of this check. Until 2026-09-04 the checker's own
failure message said only "apply each one against the live database", which for
a superseded migration is the outage; it now leads with "CHECK BEFORE YOU
APPLY" and lists the allowlisted files rather than passing over them in
silence.

### When it reports drift

A migration legitimately waiting to be applied (the contract phase of an
expand/contract change, which must land _after_ the code deploys) goes in
`migration-drift-allowlist.txt` with a note, and the entry comes out once it is
applied.

A migration whose SQL is **already live under another ledger version** goes in
the same file, but permanently, and is never applied. Establish which of the two
you have by reading the live object, not the file: if a later migration touches
the same object, applying the earlier one reinstates the older definition. See
the two worked entries above.

Everything else failing there is real drift: apply the migration and record it
in the ledger.

### Known blind spots

The check compares **identities**, not content. It cannot see:

- **An edited migration.** There is no checksum, so changing the SQL inside an
  already-recorded file is invisible. Given this repo's history of neutralising
  duplicate migrations in place, that is the most likely real-world gap.
- **A recorded-but-unapplied migration.** It proves a ledger row exists. Since
  the documented procedure writes that row by hand, a row inserted without
  running the SQL passes. Verifying the object actually exists is a human step.
- **A `.sql` file in a subdirectory, or a `.SQL` extension** — `glob("*.sql")`
  is non-recursive and case-sensitive, matching the Supabase CLI.
- **A migration already live under a DIFFERENT ledger version.** Lovable
  re-emits hand-written SQL under a filename of its own and records that
  version, leaving the original with no row. The check cannot tell that apart
  from a migration nobody ever ran, so it reports drift that is not drift — and
  its advice to apply the file is, when a later migration has replaced the same
  object, an outage. This is the blind spot with teeth: the other three make the
  check miss something, this one makes it recommend harm. See the two
  allowlisted entries above.

A ledger row with no matching file is reported as a note and does not fail: it
means the repo can no longer rebuild the live schema from scratch, which is
worth knowing but is not the drift this guard exists for.

`python3 check-migration-drift.py --selftest` exercises the matching logic (both
ledger key forms, shared version prefixes, orphan rows, the allowlist) with
inline fixtures and needs no database. `ci.yml` runs it, and the client grants
one, on every PR: with no live check in CI that self-test is the only automated
thing standing behind either checker, so keep it. It cannot validate its own
premise about how Lovable records a ledger row — only a live run does that.

## Gating policy

`check-advisors.py` fails the build only on findings that match **both** a
failing category and a failing level, set in the workflow `env`:

- `FAIL_CATEGORIES` (default `SECURITY`) — advisor categories that block.
- `FAIL_LEVELS` (default `WARN,ERROR`) — severities that block.

Every finding is printed either way, so performance/`INFO` items stay visible
without failing CI. To also gate performance, set
`FAIL_CATEGORIES: SECURITY,PERFORMANCE`; to make the advisors report-only, set
`FAIL_CATEGORIES:` (empty).

## Acknowledged findings (allowlist)

Some findings are intentional and reviewed, so they should be reported but not
block. List them in `advisors-allowlist.txt`: each non-comment line is matched
as a **substring of the finding's `cache_key`** (which starts with the lint
name), so a bare lint name acknowledges every instance while a longer
`lint_schema_object` prefix acknowledges just one object. Anything not listed
still fails CI, so a genuinely new security regression is never silently
ignored. Document why each entry is safe.

Current entries:

- `authenticated_security_definer_function_executable_public_has_role` — `has_role`
  is a `SECURITY DEFINER` helper used by RLS policies **and** called directly as
  a server RPC, so `authenticated` must keep `EXECUTE` (see migration
  `20260721023901`). The lint's suggested fix would break every manager check.
- `authenticated_security_definer_function_executable_public_has_active_paid_membership`
  — same shape: an RLS helper that the calendar server functions also call as an
  RPC on the service-role client. Read the file, it says why.

### Before you add a `*_security_definer_function_executable_*` entry

Ask first whether the app calls the function **by RPC**. If it does not — if its
only caller is an RLS policy — it does not belong in `public` at all, and the
finding is fixable rather than acknowledgeable. PostgREST routes `/rest/v1/rpc/*`
only to its `db-schemas` list (`public, graphql_public`), so a helper defined in
the `private` schema is unreachable from the API while RLS can still call it, and
the advisors (which scan the exposed schemas) stop reporting it. Migration
`20260802000000_private_rls_helpers.sql` did that to the two calendar helpers and
to `is_commenter_blocked`, and is the pattern to copy. Acknowledge only what has
a real PostgREST caller.

## Testing the checker

`check-advisors.py --selftest` runs inline fixtures over the gating logic (CSV
parsing, category/level thresholds, allowlist matching) with no database
required. CI runs it first, before spinning up Docker, so a regression in the
gate fails fast. Run it locally the same way after editing the script.

## Updating the advisor query

`splinter.sql` is a **vendored** copy of
[`supabase/splinter`](https://github.com/supabase/splinter). To refresh it,
re-download the upstream `splinter.sql` and replace everything **below** the
header comment, leaving the header intact. Its column order is what
`check-advisors.py` reads (`FIELDS`); if upstream changes those columns, update
the script to match.
