#!/usr/bin/env bash
#
# Publish one pull request's screenshot gallery to the GitHub Pages branch, or
# take it down again when the pull request closes.
#
#   PR_NUMBER=12 bash scripts/publish-pr-gallery.sh              # publish gallery/
#   PR_NUMBER=12 PR_GALLERY_REMOVE=1 bash scripts/publish-pr-gallery.sh
#
# Every pull request gets its own directory (`pr-<n>/`) on a branch that serves
# GitHub Pages, so two open pull requests never overwrite each other's pictures
# and a reviewer can open a flow without downloading anything.
#
# The branch is rewritten as a SINGLE ORPHAN COMMIT every time. Screenshots are
# large and a normal history would keep every version of every picture forever;
# with no history there is only ever one copy of each. What makes that safe
# alongside another job doing the same thing is `--force-with-lease`: the push
# names the commit this run started from, so a race loses the push rather than
# somebody else's pictures, and the loop below starts over.
#
# Environment (the workflow sets all of these):
#   GITHUB_TOKEN        a token with contents: write on this repository
#   GITHUB_REPOSITORY   owner/repo
#   PR_NUMBER           the pull request being published
#   PAGES_BRANCH        branch that serves Pages (default: gh-pages)
#   GALLERY_DIR         what to publish (default: gallery)
#   PR_GALLERY_REMOVE   set to 1 to delete this pull request's directory instead
set -euo pipefail

cd "$(dirname "$0")/.."

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

BRANCH="${PAGES_BRANCH:-gh-pages}"
GALLERY_DIR="${GALLERY_DIR:-gallery}"
DIR="pr-${PR_NUMBER}"
# Never echoed: it carries the token.
REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

if [[ "${PR_GALLERY_REMOVE:-}" != "1" && ! -d "$GALLERY_DIR" ]]; then
  echo "[gallery] nothing at $GALLERY_DIR to publish" >&2
  exit 1
fi

publish_once() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  # What the branch is at right now. Empty means it does not exist yet, which
  # is the first run on a repository and not an error.
  local head_sha
  head_sha="$(git ls-remote "$REMOTE" "refs/heads/${BRANCH}" | cut -f1)"

  if [[ -n "$head_sha" ]]; then
    git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" "$work"
  else
    git init --quiet "$work"
  fi

  rm -rf "${work:?}/${DIR}"
  if [[ "${PR_GALLERY_REMOVE:-}" != "1" ]]; then
    mkdir -p "${work}/${DIR}"
    cp -R "${GALLERY_DIR}/." "${work}/${DIR}/"
  fi

  # Jekyll would drop the underscore-prefixed files Playwright's report ships.
  touch "${work}/.nojekyll"
  write_index "$work"

  (
    cd "$work"
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git checkout --quiet --orphan publish
    git add -A
    # An empty tree (the last pull request's directory just came off) still has
    # the index page and .nojekyll in it, so there is always something to commit.
    git commit --quiet -m "Screenshots for pull request #${PR_NUMBER}"
    if [[ -n "$head_sha" ]]; then
      git push --quiet --force-with-lease="refs/heads/${BRANCH}:${head_sha}" \
        "$REMOTE" "HEAD:refs/heads/${BRANCH}"
    else
      # No branch yet: a plain push fails if somebody else created it first,
      # which the retry then picks up as an existing branch.
      git push --quiet "$REMOTE" "HEAD:refs/heads/${BRANCH}"
    fi
  )
}

# A plain listing of what is currently published, so the Pages root is not a 404.
write_index() {
  local work="$1"
  {
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    echo '<title>UTS Jitsu — pull request galleries</title>'
    echo '<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1rem}</style>'
    echo '</head><body><h1>Pull request galleries</h1><ul>'
    for dir in "$work"/pr-*; do
      [[ -d "$dir" ]] || continue
      local name
      name="$(basename "$dir")"
      echo "<li><a href=\"${name}/index.html\">${name}</a></li>"
    done
    echo '</ul><p>Each one is the end-to-end suite walking that branch. Fixture data, not the club.</p></body></html>'
  } > "${work}/index.html"
}

for attempt in 1 2 3; do
  if publish_once; then
    echo "[gallery] published ${DIR} to ${BRANCH}"
    exit 0
  fi
  echo "[gallery] attempt ${attempt} lost a race with another run, retrying" >&2
  sleep $((attempt * 3))
done

echo "[gallery] could not publish ${DIR} to ${BRANCH}" >&2
exit 1
