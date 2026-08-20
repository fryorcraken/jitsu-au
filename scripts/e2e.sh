#!/usr/bin/env bash
#
# Run the end-to-end suite the way CI does: a throwaway local Supabase stack,
# the seeded club, a production build, and Playwright driving a real browser
# over it. See docs/e2e-tests.md.
#
#   bash scripts/e2e.sh                        # the whole suite
#   bash scripts/e2e.sh --project=public       # one project
#   bash scripts/e2e.sh e2e/member --headed    # anything `playwright test` takes
#
# Everything it needs is set up inside this script rather than left to the
# caller's shell, because the pieces have to agree: the build bakes
# VITE_SUPABASE_URL in, the Nitro server reads the unprefixed names at runtime,
# and signing in is a service-role admin call that e2e/support/fixture.ts
# refuses to make against anything but the stack the club was seeded into.
#
# Two escape hatches for the slow steps, when you are iterating on a test rather
# than on the app:
#
#   E2E_SKIP_BUILD=1   reuse the .output build already on disk
#   E2E_SKIP_SEED=1    reuse the club already in the local stack
#
# And one addition, off by default because it copies every screenshot the run
# took:
#
#   E2E_GALLERY=1      build gallery/index.html afterwards — the same page CI
#                      publishes on a pull request
#
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v supabase >/dev/null 2>&1; then
  echo "The Supabase CLI is not installed: https://supabase.com/docs/guides/local-development" >&2
  exit 1
fi

# Applies every migration in supabase/migrations in order, so the suite runs
# against the schema THIS BRANCH ships. Already running is fine — `supabase
# start` is a no-op then, and re-seeding below refreshes the club.
echo "[e2e] starting the local Supabase stack"
supabase start >/dev/null

# The local stack's keys are the CLI's own development keys, printed by
# `supabase status`. Nothing here is a secret and nothing here is the club's.
eval "$(supabase status -o env)"
: "${API_URL:?supabase status reported no API_URL}"
: "${ANON_KEY:?supabase status reported no ANON_KEY}"
: "${SERVICE_ROLE_KEY:?supabase status reported no SERVICE_ROLE_KEY}"

export VITE_SUPABASE_URL="$API_URL" SUPABASE_URL="$API_URL"
export VITE_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"

if [[ "${E2E_SKIP_SEED:-}" != "1" ]]; then
  echo "[e2e] seeding the club"
  bun scripts/seed-local-club.mjs
fi

# Playwright is deliberately NOT in package.json: dependencies there have to be
# re-resolved by Lovable (CLAUDE.md > Lock file strategy), and this is a
# test-only tool. `--no-save` installs it without touching the committed
# lockfile. The version is pinned so the browser matches the driver.
PLAYWRIGHT_VERSION="$(cat scripts/playwright-version.txt)"
# Read what is on disk rather than asking bun: a `--no-save` install is by
# definition absent from package.json, so `bun pm ls` never sees it and we would
# reinstall Playwright and its browser on every run.
INSTALLED_PLAYWRIGHT="$(
  node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null || true
)"
if [[ "$INSTALLED_PLAYWRIGHT" != "$PLAYWRIGHT_VERSION" ]]; then
  echo "[e2e] installing @playwright/test@${PLAYWRIGHT_VERSION}"
  bun add --no-save "@playwright/test@${PLAYWRIGHT_VERSION}"
  bunx playwright install chromium
fi

# Which Supabase project a build was made against, recorded next to it.
#
# VITE_SUPABASE_URL is baked in at BUILD time, so a build made from `.env` — the
# live project — serves a browser that talks to production, and no runtime guard
# would notice: e2e/support/fixture.ts only checks the URL this script signs in
# against. So a reused build has to prove where it came from.
BUILD_STAMP=".output/.e2e-supabase-url"

if [[ "${E2E_SKIP_BUILD:-}" == "1" ]]; then
  if [[ "$(cat "$BUILD_STAMP" 2>/dev/null || true)" != "$API_URL" ]]; then
    echo "The build in .output was not made against $API_URL (E2E_SKIP_BUILD=1)." >&2
    echo "Re-run without E2E_SKIP_BUILD so the browser under test cannot be pointed" >&2
    echo "at the club's real database." >&2
    exit 1
  fi
else
  # NITRO_PRESET overrides the Cloudflare default so the build produces a server
  # Playwright's webServer can run directly.
  echo "[e2e] building"
  NITRO_PRESET=node-server bun run build
  printf '%s' "$API_URL" > "$BUILD_STAMP"
fi

set +e
bunx playwright test "$@"
suite_status=$?
set -e

# Built from the run's own json report, so it describes whatever just happened —
# including a failure, whose last screenshot is usually the useful one.
if [[ "${E2E_GALLERY:-}" == "1" ]]; then
  bun scripts/e2e-gallery.ts
  echo "[e2e] gallery: $(pwd)/gallery/index.html"
fi

exit "$suite_status"
