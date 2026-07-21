# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

**UTS Jitsu** — the marketing + member website for a Japanese Jiu-Jitsu club
that trains at UTS Ultimo, Sydney (public site: `https://jitsu.au`). It handles
public marketing pages, interest/contact form submissions, and a member area
where people sign a training **waiver** (with a generated PDF) and managers
review submissions.

The repo's package name is `tanstack_start_ts` — it was scaffolded from
Lovable's TanStack Start template.

## Lovable-managed project — read first

This project is connected to [Lovable](https://lovable.dev) (see `AGENTS.md`).

- **Never rewrite published git history** — no force-push, and no
  rebasing/amending/squashing commits that are already pushed. Doing so
  rewrites history on Lovable's side and the user can lose project history.
- Commits pushed to the connected branch **sync back to Lovable** and appear in
  the editor, so keep the branch in a working (buildable) state.
- `.lovable/` holds Lovable metadata (`project.json`) and the current work
  plan (`plan.md`). `src/routes/lovable/**` and `@lovable.dev/*` packages are
  Lovable platform integrations.

## Tech stack

- **Framework:** [TanStack Start](https://tanstack.com/start) (full-stack React
  with SSR) on **TanStack Router** (file-based routing).
- **UI:** React 19, TypeScript (strict), Tailwind CSS **v4**, shadcn/ui
  (`new-york` style, in `src/components/ui`), lucide-react icons, sonner toasts.
- **Data / auth:** Supabase (Postgres + Auth + Storage), `@tanstack/react-query`.
- **Build:** Vite 8 + Nitro (default deploy target **Cloudflare**), configured
  through `@lovable.dev/vite-tanstack-config`.
- **Forms/validation:** react-hook-form + Zod. **PDF:** `pdf-lib`. **Signatures:**
  `signature_pad`. **Email:** `@react-email/*` + `@lovable.dev/email-js`.
- **Package manager:** **Bun** (`bun.lock`, `bunfig.toml`).

## Commands

Use **Bun** (this is a Bun project — `bun install`, not npm/pnpm).

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies |
| `bun run dev` | Start the Vite dev server |
| `bun run build` | Production build (Nitro) |
| `bun run build:dev` | Build in development mode |
| `bun run preview` | Preview the production build |
| `bun run lint` | ESLint over the repo |
| `bun run format` | Prettier `--write` over the repo |
| `bun run test` | Run the Vitest suite once (CI mode) |
| `bun run test:watch` | Vitest in watch mode |
| `bun run test:coverage` | Vitest with a V8 coverage report |

Verify changes with `bun run test`, `bun run lint`, and `bun run build` (the
build also type-checks). These three run in CI on every PR (see Testing & CI).

`bunfig.toml` enforces a **24-hour supply-chain guard** (`minimumReleaseAge`):
packages published less than a day ago are skipped. Only `@lovable.dev/*`
packages are excluded. Confirm with the user before adding any exclusion.

## Project layout

```
src/
  routes/                 File-based routes (see src/routes/README.md)
    __root.tsx            App shell: <html>, head/meta, QueryClientProvider, Toaster, error+404 boundaries
    _authenticated/       Auth-gated route group (ssr:false, redirects to /auth)
      route.tsx           Guard: redirects unauthenticated users
      account.tsx         Member account page
      manager.waivers.tsx        Manager: list signed waivers
      manager.waiver-template.tsx Manager: edit waiver template
    lovable/email/auth/   Lovable auth-email webhook + preview routes
    index.tsx, about.tsx, classes.tsx, pricing.tsx, instructors.tsx,
    faq.tsx, contact.tsx, register-interest.tsx, waiver.tsx, auth.tsx, ...
    routeTree.gen.ts      AUTO-GENERATED route tree — never edit by hand
  components/
    ui/                   shadcn/ui primitives (generated; avoid hand-editing)
    site/                 App chrome: SiteHeader, SiteFooter, SiteLayout, SignaturePad
  integrations/supabase/  Supabase clients + auth middleware + generated types
  lib/                    Business logic, server functions, PDF, email templates, utils
  hooks/                  useAuth / useRoles, use-mobile
  router.tsx              createRouter() factory (QueryClient in context)
  server.ts               SSR entry — wraps errors into a rendered error page
  start.ts                createStart(): global function + request middleware
  styles.css              Tailwind v4 entry + design tokens
supabase/
  config.toml             Supabase project ref
  migrations/*.sql        Schema + RLS (timestamped, applied in order)
```

## Routing conventions (TanStack Start — NOT Next.js/Remix)

Read `src/routes/README.md` before touching routes. Key points:

- Every `.tsx` in `src/routes/` is a route. **Do not** create `src/pages/`,
  `app/layout.tsx`, or other Next.js/Remix conventions.
- The only root layout is `src/routes/__root.tsx`; keep its `<Outlet />`.
- Naming: `index.tsx` → `/`; `$id.tsx` → dynamic (bare `$`); `_layout.tsx` →
  layout route; `_authenticated/` → pathless group (auth gate). Dotted names
  like `manager.waivers.tsx` map to nested paths (`/manager/waivers`).
- `routeTree.gen.ts` is regenerated by the router plugin — never edit it.

## Data & server functions

- **Server functions** live in `src/lib/*.functions.ts` and use
  `createServerFn()` from `@tanstack/react-start`. Client code calls them via
  `useServerFn(fn)` (see `src/routes/register-interest.tsx`). Validate every
  input with a Zod `.inputValidator(...)`.
- ⚠️ **`*.functions.ts` and route files are bundled to the client.** Do **not**
  top-level `import` `client.server.ts` (service-role key) from them. Instead
  lazy-load inside the handler:
  `const { supabaseAdmin } = await import("@/integrations/supabase/client.server")`.
- Forms include a honeypot field `hp` (a hidden input that must stay empty);
  handlers early-return on a filled `hp`.

## Supabase clients — pick the right one

| Module | Runs where | Auth level | Use for |
| --- | --- | --- | --- |
| `integrations/supabase/client.ts` (`supabase`) | Browser (also SSR fallback) | Publishable/anon key, RLS-enforced, user session | Client components, `useAuth`, auth-gate `beforeLoad` |
| `integrations/supabase/auth-middleware.ts` (`requireSupabaseAuth`) | Server fn | Verifies the caller's bearer token, RLS-enforced **as that user** | Authenticated server functions; exposes `context.supabase`, `context.userId`, `context.claims` |
| `integrations/supabase/client.server.ts` (`supabaseAdmin`) | Server only | **Service role — bypasses RLS** | Trusted admin writes (waiver insert, PDF upload, signed URLs). Never ship to client. |

- `attachSupabaseAuth` (registered as a `functionMiddleware` in `start.ts`)
  attaches the browser's bearer token to every server-function RPC — without it,
  `requireSupabaseAuth` gets no token.
- `client.ts`, `client.server.ts`, `auth-middleware.ts`, and `types.ts` are
  **auto-generated** ("Do not edit it directly"). Prefer regenerating over hand-edits.

## Auth & roles

- Auth is Supabase email/password + magic link; the auth UI is `routes/auth.tsx`.
- `_authenticated/route.tsx` gates the group: `ssr: false`, redirects to
  `/auth?redirect=...` when there is no user.
- Roles come from the `user_roles` table and the `app_role` enum
  (`manager` | `member`). Check via the `has_role(_user_id, _role)` security-
  definer RPC on the server, or the `useRoles(userId)` hook (`isManager`) on the
  client. Manager pages both guard in the server fn **and** redirect non-managers
  client-side (see `manager.waivers.tsx`).

## Database (Supabase)

Schema lives in `supabase/migrations/*.sql` (timestamped, applied in order). All
tables use RLS. Core tables:

- `interest_registrations`, `contact_messages` — public insert-only (anon), with
  column-length/format CHECK constraints in the RLS `WITH CHECK`.
- `waivers` — signed training waivers (personal + emergency + medical + guardian
  fields, acknowledgements JSONB, signature name/image paths, `pdf_path`,
  `template_version`, optional `user_id`). Public insert allowed under strict
  RLS validation.
- `waiver_templates` — versioned markdown templates; a partial unique index
  enforces exactly one `is_current = true`. Body uses `{{placeholder}}` tokens.
  Manager-only insert/update.
- `user_roles` — role assignments; managed by managers / service role.

Signed waiver PDFs and signature PNGs are stored in the Supabase Storage
**`waivers`** bucket; access is via short-lived signed URLs.

## Key business flows

- **Waiver signing** (`routes/waiver.tsx` → `lib/waiver.functions.ts`
  `submitWaiverWithPdf`): validate → insert row (service role) → upload signature
  PNGs → render PDF with `lib/waiver-pdf.ts` (`pdf-lib`) → upload to `waivers`
  bucket → return a signed URL. Supports minors (guardian block) and draw/typed
  signatures (`components/site/SignaturePad.tsx`). `getMyLatestWaiver` prefills
  returning users.
- **Interest / contact** (`lib/submissions.functions.ts`): validate → insert to
  the respective public table.
- **Auth emails** (`routes/lovable/email/auth/webhook.ts`): a Lovable
  `createAuthEmailHandler` dispatches React-email templates from
  `src/lib/email-templates/` for signup, invite, magic-link, recovery, etc.

## Testing & CI

- **Runner:** [Vitest](https://vitest.dev) with a **standalone `vitest.config.ts`**
  (jsdom environment, React plugin, `@/` alias). It is deliberately **not** the
  Lovable-wrapped `vite.config.ts` — that config injects TanStack Start / Nitro
  SSR plugins that must not run under the test runner. `vitest.setup.ts` wires up
  `@testing-library/jest-dom` matchers and per-test DOM cleanup.
- **Layout:** tests live next to the code as `*.test.ts(x)` under `src/`.
- **What's covered today:**
  - `src/lib/validation.test.ts` — the form/validation business rules
    (interest, contact, waiver, template schemas + `composeFullName` /
    `decodeDataUrlPng`). This is the highest-value suite: it pins the honeypot,
    signature-required, and minor/guardian rules.
  - `src/lib/utils.test.ts` — the `cn()` class-merge helper.
  - `src/components/ui/button.test.tsx` — a Testing Library smoke test proving
    the jsdom/component setup works (render, variants, click, `asChild`).
- **Where to add tests:** pure logic belongs in `src/lib/` modules (import and
  test the real export — see how validation was extracted out of the
  `*.functions.ts` handlers so it's testable without a server context). For
  components, render with `@testing-library/react` and assert on roles/text.
- **Validation lives in `src/lib/validation.ts`** — a side-effect-free, server-
  import-free module shared by the `*.functions.ts` handlers. Keep new form
  rules there so they stay unit-testable; the server functions just import and
  `.parse()`.
- **CI:** `.github/workflows/ci.yml` runs lint → test → build on Linux with Bun
  for every PR and pushes to `main`. It uses `bun install` (not
  `--frozen-lockfile`): `bun.lock` is materialised in Lovable's build
  environment, so CI resolves against the public npm registry.

> Note on installing deps: the default registry in `bun.lock` is Lovable's
> private mirror. Some sandboxes block it; if `bun install` 403s on
> `europe-west1-npm.pkg.dev`, install against public npm
> (`bun install --registry=https://registry.npmjs.org`) — package contents are
> identical.

## Conventions & style

- **Formatting (Prettier):** `printWidth: 100`, semicolons, **double quotes**,
  `trailingComma: "all"`. Run `bun run format`.
- **Imports:** use the `@/` alias for `src/` (e.g. `@/components/ui/button`).
- **ESLint:** flat config; `react-hooks` + `react-refresh` rules. A
  `no-restricted-imports` rule bans the Next.js `server-only` package — use a
  `*.server.ts` filename or `@tanstack/react-start/server-only` instead.
- **Styling:** Tailwind utility classes; compose conditionals with `cn()` from
  `@/lib/utils`. Reuse `components/ui` primitives and the `SiteLayout`
  (`SiteHeader`/`SiteFooter`) shell for pages. Theme tokens (`bg-background`,
  `text-muted-foreground`, etc.) come from `styles.css`.
- Every public page sets SEO `head()` meta (title/description/og/canonical);
  manager pages set `robots: noindex`. Match the existing pattern when adding pages.

## Environment variables

Configured via Lovable Cloud (`.env` locally; values are secrets, not committed
meaningfully). The app reads:

- Client (Vite, build-time): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_SUPABASE_PROJECT_ID`.
- Server: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  (admin client only), plus `LOVABLE_API_KEY` / `LOVABLE_SEND_URL` for auth email.

Missing Supabase vars throw a clear "Connect Supabase in Lovable Cloud" error.

## When making changes

1. Develop on the assigned feature branch; commit in a working state (Lovable
   syncs the branch). **Never** force-push or rewrite pushed history.
2. Don't hand-edit generated files: `routeTree.gen.ts`, the Supabase
   `integrations/supabase/*` clients/types, or `components/ui/*` primitives.
3. Keep the service-role client (`client.server.ts`) off the client bundle —
   lazy-`import` it inside server handlers only.
4. Validate all server-function input with Zod; enforce manager access with
   `has_role` / `requireSupabaseAuth`, never trust the client.
5. Verify with `bun run test`, `bun run lint`, and `bun run build`.
