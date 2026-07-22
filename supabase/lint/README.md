# Supabase lint (CI)

`.github/workflows/supabase-lint.yml` starts a throwaway local Postgres with
`supabase db start` (which applies every migration in `../migrations`) and runs
**both** Supabase linters against it. It is path-filtered to `supabase/**`, so
frontend-only PRs don't pay for a Docker database.

## What runs

| Check | Tool | Catches |
| ----- | ---- | ------- |
| **Advisors** | `splinter.sql` via `psql` → `check-advisors.py` | The Security/Performance lints from the dashboard's **Database > Advisors**, e.g. `function_search_path_mutable` (a `SECURITY DEFINER` function without a fixed `search_path`). |
| **plpgsql_check** | `supabase db lint --schema public --fail-on warning` | Errors in `public` PL/pgSQL function bodies (unused variables, bad SQL, etc.). |

`supabase db lint` is scoped to `public` on purpose: Supabase-managed schemas
(`storage`, `auth`, …) ship functions that emit warnings we don't control.

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

## Updating the advisor query

`splinter.sql` is a **vendored** copy of
[`supabase/splinter`](https://github.com/supabase/splinter). To refresh it,
re-download the upstream `splinter.sql` and replace everything **below** the
header comment, leaving the header intact. Its column order is what
`check-advisors.py` reads (`FIELDS`); if upstream changes those columns, update
the script to match.
