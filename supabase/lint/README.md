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

## Updating the advisor query

`splinter.sql` is a **vendored** copy of
[`supabase/splinter`](https://github.com/supabase/splinter). To refresh it,
re-download the upstream `splinter.sql` and replace everything **below** the
header comment, leaving the header intact. Its column order is what
`check-advisors.py` reads (`FIELDS`); if upstream changes those columns, update
the script to match.
