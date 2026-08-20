# End-to-end tests

The unit suite (`bun run test`) proves a rule or a component in isolation. This
suite proves a **person can get through a flow**: fill in the interest form and
be offered their waiver, ask for a member screen while signed out and be sent to
sign in, sign in and find your account, open the manager screens and see what
the club has been sent.

It is the only place SSR, the server functions, RLS, storage and the router's
own redirects are exercised together, in a browser, against a real database.

It is also where the **pull request's screenshots** come from. Every test is
photographed as it goes, so what a reviewer opens is the flow this suite walked
rather than a set of pages photographed cold by a separate program. See
"Screenshots" below.

## Running it

```bash
bun run test:e2e                        # the whole suite
bun run test:e2e -- --project=public    # one project
bun run test:e2e -- e2e/member --headed # anything `playwright test` takes
```

`scripts/e2e.sh` does the whole setup, because the pieces have to agree with
each other:

1. `supabase start` — Postgres, Auth, PostgREST and Storage, with every
   migration in `supabase/migrations` applied in order, so the flows are walked
   against the schema **this branch** ships.
2. `scripts/seed-local-club.mjs` — fills it with a manager, a member and an
   applicant, and writes `.local-club-fixture.json`. The club the flows are
   walked on, and the club a reviewer sees in the screenshots.
3. `bun add --no-save @playwright/test` at the version pinned in
   `scripts/playwright-version.txt`, plus its chromium.
4. `NITRO_PRESET=node-server bun run build` — the **production** build, not the
   dev server. SSR and the server functions are most of what is under test and
   only the build exercises them the way Cloudflare will.
5. `playwright test`, which serves that build and drives it.

Three switches for iterating on a test rather than on the app: `E2E_SKIP_BUILD=1`
reuses the build on disk, `E2E_SKIP_SEED=1` reuses the club already in the stack,
and `E2E_SHOTS=0` skips the screenshots. `E2E_GALLERY=1` goes the other way and
builds `gallery/index.html` afterwards — the page CI publishes.

Skipping the build refuses to reuse one made against a different Supabase
project: `VITE_SUPABASE_URL` is baked in at build time, so an `.env`-flavoured
build would serve a browser talking to the live club and no runtime guard would
see it.

After a run, `playwright-report/index.html` has the results; a failure carries
its trace, screenshot and video, and `bunx playwright show-trace` replays it
click by click.

Prerequisites: the [Supabase CLI](https://supabase.com/docs/guides/local-development)
and Docker. Without them, `scripts/e2e.sh` stops and says so.

## What is here

```
playwright.config.ts        projects, the served build, report settings
e2e/
  support/
    fixture.ts              the seeded club + the "local stack only" guard
    auth.setup.ts           signs each persona in once, saves the session
    page.ts                 shared assertions and the nav helper
    test.ts                 the suite's own `test` — import from here, not @playwright/test
    screenshots.ts          `step` and `shot`: the pictures a run leaves behind
    club-state.ts           puts back what walking the site consumed
  public/                   flows anyone can walk (run at desktop AND phone width)
  member/                   flows a signed-in member walks
  manager/                  flows a manager walks
  tour/                     every page there is, opened and photographed
scripts/
  site-pages.ts             which pages the tour walks, and as whom
  e2e-gallery.ts            turns a run into gallery/index.html
  e2e-gallery-report.ts     the layout rules, unit-tested on their own
  publish-pr-gallery.sh     puts a pull request's gallery on the Pages branch
```

A spec goes in the directory named after **who walks the flow**. That is what
decides which session it starts with: `public/` starts signed out, `member/` and
`manager/` start from the matching persona's saved session, and Playwright signs
those personas in once for the whole run rather than per test.

`public/` is walked twice, at desktop and phone width, because most of this
club's traffic is phones and the header nav is behind a menu button down there
(use `siteNavLink` from `support/page.ts` rather than clicking the link
directly). The manager screens are laptop-only, which is where that admin
actually gets done.

## Rules worth knowing before you add one

- **The suite is serial, and the club is shared.** Every test reads and writes
  one seeded database, so `playwright.config.ts` runs a single worker. If your
  test writes something, clean it up (see `public/register-interest.spec.ts`) —
  a lead nobody removed shows up on the manager's screens for every later run.
- **Never write the row the app was supposed to write.** `adminClient()` in
  `support/fixture.ts` is for arranging a starting state and for reading back
  what a flow produced. A test that inserts the record itself passes whether or
  not the app works.
- **These tests never talk to the hosted project.** `support/fixture.ts` refuses
  any Supabase URL that is not loopback, and refuses a manifest seeded against a
  different database — signing in is a service-role admin call and GoTrue's
  `generate_link` **creates** an account that does not exist, so a misdirected
  run would put fixture people in the club's real auth. That guard is not
  theoretical: bun auto-loads `.env`, which locally holds the **live** project's
  URL, so anything that does not export the local values itself inherits them.
  `scripts/e2e.sh` exports all of them, which is why it is the way to run this.
- **Assert on what the person sees.** Roles and text (`getByRole`,
  `getByLabel`), not CSS classes or test ids. If a flow is hard to address that
  way, that is usually the screen missing a label rather than the test needing a
  hook.
- **A membership status or funnel phase is words, not the enum behind it.**
  Those two go through `src/lib/status-labels.ts`, and `toContainText` is
  case-sensitive — so it is `"Active"`, not `"active"`. An ended membership is
  worse than a casing difference: it reads "Used up" or "Expired" depending on
  the plan behind it and on what is left on the row (`docs/memberships.md`,
  "What an ended membership is called"). Read the label off the screen, never
  off the database row you seeded.
  **Only those two.** Waiver, blog-post and blog-comment pills still render
  their raw lowercase status through the `capitalize` class, which changes
  nothing about `textContent` — which is why `e2e/manager/waivers.spec.ts`
  asserting `"active"` is correct and must not be "fixed" to match the rule
  above.
- **`expectPageRendered` catches a page that rendered a failure boundary.** Both
  the router's error boundary and its 404 arrive inside an ordinary 200
  response, so a status check alone would call a site-wide "This page didn't
  load" a clean run. It does **not** catch a route that handles its own loader
  error and renders a card in place of its content — assert on the content the
  flow needs.
- **Import `test` from `../support/test`, not from `@playwright/test`, and use
  `step` instead of `test.step`.** That is what photographs the flow;
  `scripts/e2e-conventions.test.ts` fails the unit suite if a spec reaches past
  either, because the run would still be green and the screen would simply stop
  appearing in what reviewers look at.
- **Playwright is not in `package.json`,** deliberately: dependencies there have
  to be re-resolved by Lovable (CLAUDE.md > Lock file strategy) and this is a
  test-only tool. It is installed with `--no-save` at the version in
  `scripts/playwright-version.txt`.
- **The tests are typechecked separately.** They are outside the app's
  `tsconfig.json` (it has no `@playwright/test`), so
  `bunx tsc -p e2e/tsconfig.json` is what checks them, and the e2e workflow runs
  it before the suite.

## Screenshots

A screenshot here is a **byproduct of a test that was going to run anyway**. The
suite already opens the pages, fills the forms and clicks the buttons; taking a
picture on the way costs a moment and gives a reviewer the one thing a diff
cannot show them.

Three pieces, all of them Playwright's own API plus one web API
(`document.fonts.ready`, so a picture is never taken mid font-swap):

- **`step(page, title, body)`** (`e2e/support/screenshots.ts`) is `test.step`
  with a picture of where the step left the person. The page is a parameter
  because a flow like the new-member journey drives three of them — an anonymous
  visitor, the member, the manager — and which one a step is about is exactly
  what is worth being explicit on. The shot is taken in a `finally`, so a step
  that **fails** is photographed too; that picture is usually the most useful one
  in the run.
- **`shot(page, name)`** for a screen that a step would otherwise replace before
  it was seen — the filled-in waiver, say, which is gone the moment it is
  submitted.
- **Every test is photographed where it ended**, without asking, by the auto
  fixture in `e2e/support/test.ts`. A spec with no steps at all still appears.

`e2e/tour/site.spec.ts` is the other half: it opens **every page the site
serves**, asserts it rendered, and is photographed doing it. The public pages
come from `src/lib/public-pages.ts` (the sitemap's own list plus the noindex
pages nothing can derive) and the signed-in ones from the route files themselves
(`scripts/site-pages.ts`), so a new manager screen is covered the moment its file
exists. It runs as two projects, `tour` and `tour-mobile`, because a screen that
breaks on a phone is a broken screen.

Walking the site is not read-only — `/notifications` marks the member's unread
ones read, a manager inbox stamps its "seen" watermark — so `restoreSeenState`
(`e2e/support/club-state.ts`) puts those back after each pass. It is a **known
list**: a new screen that marks something read when it opens has to be added, or
its unread state will only ever appear in the desktop gallery.

### The gallery

`scripts/e2e-gallery.ts` reads Playwright's own json report (which already knows
which tests ran, in which project, with which screenshots attached in what
order), copies the images somewhere publishable and lays them out: the flows
first, as strips of screens in the order somebody walked them, then every page
at desktop and phone width. Playwright's HTML report rides along at
`report/index.html`, which is where a failure's trace and video are — served over
http, its trace viewer opens inline.

Locally:

```bash
E2E_GALLERY=1 bun run test:e2e     # -> gallery/index.html
```

## CI

`.github/workflows/e2e.yml` runs all of the above on every pull request and on
pushes to `main`, path-filtered away from documentation-only changes. It needs
**no repository secrets**: the local stack's keys are the CLI's own development
keys.

On a pull request it then publishes the gallery to **GitHub Pages** under
`pr-<n>/` (`scripts/publish-pr-gallery.sh`) and posts one sticky comment with the
flow strips embedded, so reviewing a change means looking at it rather than
downloading a zip. `.github/workflows/pr-gallery-cleanup.yml` takes the directory
down when the pull request closes.

Three things about that publish are worth knowing:

- **Pages is served from GitHub Actions**, which deploys one artifact per
  deployment and replaces the whole site each time. So the galleries accumulate
  on a **store branch** (`gh-pages`), and `.github/workflows/pages-deploy.yml`
  deploys that whole tree — otherwise this pull request's deployment would take
  every other open one's gallery down with it. It reads the branch as it is at
  deploy time rather than reusing what the suite pushed, so a run that finished
  meanwhile is carried along rather than reverted. No secret is involved: the
  workflow's own `GITHUB_TOKEN` writes the branch, and the deployment uses the
  repository's OIDC token.
- That deploy is a **separate workflow on a `workflow_run` trigger, and it has
  to be**: the `github-pages` environment only accepts deployments from the
  default branch, so a job running on a pull request's branch is refused before
  it starts — no runner, no steps, no log, just a red check. A `workflow_run`
  workflow runs in the default branch's context, which is allowed. The cost is
  that it only fires from the copy of the file on `main`, so **the pull request
  that changes it cannot see its own gallery deployed**. (The other way to have
  it: allow non-default branches to deploy in Settings → Environments →
  github-pages. That trades a protection for immediacy; this repo keeps the
  protection.)
- The store branch is rewritten as a **single orphan commit** every time.
  Screenshots are large and a normal history would keep every version of every
  picture forever. Two runs racing is handled by `--force-with-lease`: the loser
  retries rather than overwriting the other's pictures.
- A **fork's** pull request gets a read-only token whatever the workflow asks
  for, so it can neither push the store branch nor post the comment. Its run
  still walks everything and still uploads the gallery as an artifact; the
  gallery is on the run's own page rather than on the pull request. Nothing
  fails.

The suite is allowed one retry, for the genuine flake of a browser against a
server against a database. It is not a licence for a flaky test — anything that
only passes on the second attempt is a bug, and the first attempt's trace is in
the report so it can be found. A red suite still produces its gallery and its
comment, and the job is failed afterwards: the screenshot of the step that broke
is the most useful thing in the run.

## What is deliberately not covered yet

This is the scaffold. It carries one flow per audience to prove the harness
works end to end; the rest arrive in their own changes. The membership and
invoice flows are now covered (`manager/memberships.spec.ts`,
`manager/check-in.spec.ts`, `member/membership.spec.ts`), and so is the whole
new-member story end to end — register, sign, get approved, use the trial,
buy a plan, get checked in on it, get paid, and later switch plans
(`manager/new-member-journey.spec.ts`, one connected test rather than one
screen). The obvious next thing left is the knowledge base.
