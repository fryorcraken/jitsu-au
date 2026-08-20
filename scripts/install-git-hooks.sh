#!/usr/bin/env bash
#
# Point git at the repo's versioned hooks (`.githooks/`).
#
# Git's own hook directory (`.git/hooks`) is not versioned, so a hook written
# there reaches exactly one machine. `core.hooksPath` moves the whole directory
# into the repo, which is why the hooks live in `.githooks/` and this one-liner
# exists to switch it on. It is a local git config change: per-clone, reversible
# with `git config --unset core.hooksPath`, and invisible to everyone else.
#
# `bun run deps` runs this, so a normal install sets it up. Safe to re-run.
#
# Deliberately not husky: that would mean a new dependency, and adding one here
# means editing package.json and waiting for Lovable to re-resolve the lockfile
# (CLAUDE.md > Lock file strategy). Two git config lines do not justify that.
set -euo pipefail

cd "$(dirname "$0")/.."

# No-op outside a git checkout (a tarball export, some CI images).
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

chmod +x .githooks/* 2>/dev/null || true

if [[ "$(git config --get core.hooksPath || true)" == ".githooks" ]]; then
  exit 0
fi

git config core.hooksPath .githooks
echo "[hooks] core.hooksPath -> .githooks (pre-commit now guards .env)"
