#!/usr/bin/env bash
#
# Lockfile-preserving dependency install for environments that cannot reach
# Lovable's private npm mirror (Claude sandboxes, local dev, GitHub CI).
#
# Why this exists
# ---------------
# Lovable resolves dependencies against its private Artifact Registry mirror
# (`*.pkg.dev/<project>/sandbox-npm-cache/...`) and pins those *absolute*
# tarball URLs into `bun.lock`. That mirror is unreachable outside Lovable, so
# a plain `bun install` against the committed lock 403s on a cold machine.
#
# `bun install --registry=...` does NOT help: the flag only changes the default
# registry used for resolution, it does not override absolute tarball URLs that
# are already pinned in a text lockfile.
#
# What works (and what this script does): rewrite the pinned private-mirror
# base URL to its public-npm equivalent, then install. The path structure
# (`<pkg>/-/<file>`) and the integrity hashes are identical, and every package
# (including `@lovable.dev/*`) is published to public npm — so this installs
# Lovable's EXACT locked versions, just from a reachable registry.
#
# `bun.lock` is restored to its committed form afterward, so this install never
# rewrites the lock and can never be accidentally committed. Lovable stays the
# single source of truth for the lockfile.
#
# Usage: bash scripts/bun-install.sh   (pass no extra args — this is a sync
#        install of the committed dependencies, not an add/remove).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -gt 0 ]]; then
  echo "scripts/bun-install.sh installs the committed dependency set only." >&2
  echo "To add/remove a dependency, change package.json and let Lovable" >&2
  echo "re-resolve the lockfile (see CLAUDE.md > Lock file strategy)." >&2
  exit 2
fi

LOCK="bun.lock"

if [[ ! -f "$LOCK" ]]; then
  echo "No $LOCK found; running a plain 'bun install'." >&2
  exec bun install
fi

# Restore the committed lockfile on any exit, so the rewrite below is never
# left in the working tree.
BACKUP="$(mktemp)"
cp "$LOCK" "$BACKUP"
trap 'cp "$BACKUP" "$LOCK"; rm -f "$BACKUP"' EXIT

# Rewrite the Lovable private-mirror base URL -> public npm. Anchored on the
# `sandbox-npm-cache` repo name so it is robust to region/project changes but
# only ever touches Lovable mirror URLs.
sed -E -i 's#https://[a-z0-9.-]+\.pkg\.dev/[^/]+/sandbox-npm-cache/#https://registry.npmjs.org/#g' "$LOCK"

# Non-frozen: bun cosmetically normalises away the now-redundant public URLs
# (they equal the default registry). Versions and integrity are unchanged.
bun install
