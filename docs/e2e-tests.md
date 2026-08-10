# End-to-end tests

The unit suite (`bun run test`) proves a rule or a component in isolation. This
suite proves a **person can get through a flow**: fill in the interest form and
be offered their waiver, ask for a member screen while signed out and be sent to
sign in, sign in and find your account, open the manager screens and see what
the club has been sent.

It is the only place SSR, the server functions, RLS, storage and the router's
own redirects are exercised together, in a browser, against a real database.

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
   applicant, and writes `.local-club-fixture.json`. This is the **same seed the
   PR screenshots use**; neither job owns it.
3. `bun add --no-save @playwright/test` at the version pinned in
   `scripts/playwright-version.txt`, plus its chromium.
4. `NITRO_PRESET=node-server bun run build` — the **production** build, not the
   dev server. SSR and the server functions are most of what is under test and
   only the build exercises them the way Cloudflare will.
5. `playwright test`, which serves that build and drives it.

Two escape hatches while iterating on a test rather than on the app:
`E2E_SKIP_BUILD=1` reuses the build on disk, `E2E_SKIP_SEED=1` reuses the club
already in the stack.

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
  public/                   flows anyone can walk (run at desktop AND phone width)
  member/                   flows a signed-in member walks
  manager/                  flows a manager walks
```

A spec goes in the directory named after **who walks the flow**. That is what
decides which session it starts with: `public/` starts signed out, `member/` and
`manager/` start from the matching persona's saved session, and Playwright signs
those personas in once for the whole run rather than per test.

`public/` is walked twice, at desktop and phone width, because most of this
club's traffic is phones and the header nav is behind a menu button down there
(use `openSiteNav` from `support/page.ts` rather than clicking the link
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
- **`expectPageRendered` catches a page that rendered a failure boundary.** Both
  the router's error boundary and its 404 arrive inside an ordinary 200
  response, so a status check alone would call a site-wide "This page didn't
  load" a clean run. It does **not** catch a route that handles its own loader
  error and renders a card in place of its content — assert on the content the
  flow needs.
- **Playwright is not in `package.json`,** deliberately: dependencies there have
  to be re-resolved by Lovable (CLAUDE.md > Lock file strategy) and this is a
  test-only tool. It is installed with `--no-save` at the version in
  `scripts/playwright-version.txt`, which is also what the PR screenshot job
  reads, so the two never drift onto different browsers.
- **The tests are typechecked separately.** They are outside the app's
  `tsconfig.json` (it has no `@playwright/test`), so
  `bunx tsc -p e2e/tsconfig.json` is what checks them, and the e2e workflow runs
  it before the suite.

## CI

`.github/workflows/e2e.yml` runs all of the above on every pull request and on
pushes to `main`, path-filtered away from documentation-only changes. It needs
**no repository secrets**: the local stack's keys are the CLI's own development
keys. The Playwright report is uploaded as an artifact on every run, green or
red.

One retry is allowed, for the genuine flake of a browser against a server
against a database. It is not a licence for a flaky test — anything that only
passes on the second attempt is a bug, and the first attempt's trace is in the
artifact so it can be found.

## What is deliberately not covered yet

This is the scaffold. It carries one flow per audience to prove the harness
works end to end; the rest arrive in their own changes. The obvious next ones:
signing a waiver through to the PDF, a manager approving one and the member's
login being set up, the membership and invoice flows, and the knowledge base.
