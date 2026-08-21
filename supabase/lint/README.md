# Supabase lint (CI)

`.github/workflows/supabase-lint.yml` starts a throwaway local Postgres with
`supabase db start` (which applies every migration in `../migrations`) and runs
**both** Supabase linters against it. It is path-filtered to `supabase/**`, so
frontend-only PRs don't pay for a Docker database.

This directory also holds the **migration drift** check, which is _not_ part of
that workflow: it runs from `../../.github/workflows/migration-drift.yml` on
pushes to `main`, on a daily schedule, and on demand — and it talks to the
**live** database rather than a local one.

## What runs

| Check               | Tool                                                 | Catches                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Advisors**        | `splinter.sql` via `psql` → `check-advisors.py`      | The Security/Performance lints from the dashboard's **Database > Advisors**, e.g. `function_search_path_mutable` (a `SECURITY DEFINER` function without a fixed `search_path`). |
| **plpgsql_check**   | `supabase db lint --schema public --fail-on warning` | Errors in `public` PL/pgSQL function bodies (unused variables, bad SQL, etc.).                                                                                                  |
| **Migration drift** | `check-migration-drift.py` against the live ledger   | A migration file that has never been applied to the live database. Committing a migration does not apply it — see `docs/database-changes.md`.                                   |

`supabase db lint` is scoped to `public` on purpose: Supabase-managed schemas
(`storage`, `auth`, …) ship functions that emit warnings we don't control.

## Migration drift

The local replay above proves a migration _can_ apply; it says nothing about
whether it _has_. Nothing in this pipeline runs `../migrations/*.sql` against
the real database, so `check-migration-drift.py` reads
`supabase_migrations.schema_migrations` from the live project and compares it to
the files on disk.

### Why it does not run on pull requests

`migration-drift.yml` runs on pushes to `main`, on a daily schedule, and on
demand — never on `pull_request`. The job holds a production database
credential, and this repo takes **same-repo** feature branches from Lovable and
from coding agents. GitHub withholds secrets from fork PRs but **not** from
same-repo branch PRs, so a PR-triggered job would hand the credential to a
script that the same PR is allowed to rewrite. One added line in
`check-migration-drift.py` would exfiltrate it.

The trade-off is that drift surfaces one merge later instead of in the PR. That
is acceptable: an unapplied migration is a persistent state, not a property of
one PR, so the next push to `main` or the daily run finds it — and the real
guard is the rule that a migration is applied in the session that writes it.
The checker's `--selftest` still runs on every PR from `ci.yml`, so a change to
the matching logic is exercised before it merges.

### Setting up the credential

Set `SUPABASE_DB_URL` as a repository secret. **Do not paste the dashboard's
default connection URI** — that is the `postgres` superuser, with read/write on
every table including `auth.users` and the `waivers` PII.

`supabase_migrations` is not readable by `anon`, `authenticated` or
`service_role`, so there is no off-the-shelf read-only key that works. Create a
purpose-built role instead:

```sql
CREATE ROLE ci_migration_reader LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA supabase_migrations TO ci_migration_reader;
GRANT SELECT ON supabase_migrations.schema_migrations TO ci_migration_reader;
```

That is the entire privilege the check needs. Note GitHub-hosted runners are
IPv4-only while `db.<ref>.supabase.co` is IPv6-only, so the secret likely needs
the Supavisor session-pooler host rather than the direct one. A wrong host fails
the job loudly (psql exit 2); it cannot pass silently.

### Reading the result

Without the secret both steps write a notice to the run summary and **fail**.
That is deliberate: an unarmed check that passed made every run green while
asking the database nothing, which is worse than having no check, because a
green tick is what stops anyone from looking. So a red job here means either
real drift or a missing secret, and the summary says which. Never soften the
guard back to a pass to clear the tick.

A migration legitimately waiting to be applied (the contract phase of an
expand/contract change, which must land _after_ the code deploys) goes in
`migration-drift-allowlist.txt` with a note. Everything else failing there is
real drift: apply the migration and record it in the ledger.

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

A ledger row with no matching file is reported as a note and does not fail: it
means the repo can no longer rebuild the live schema from scratch, which is
worth knowing but is not the drift this guard exists for.

`python3 check-migration-drift.py --selftest` exercises the matching logic (both
ledger key forms, shared version prefixes, orphan rows, the allowlist) with
inline fixtures and needs no database. It cannot validate its own premise about
how Lovable records a ledger row — only a live run does that.

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
