<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

## Database

The schema reference lives in **`docs/database.md`** (every table: columns,
RLS, relationships, storage). The product spec for the waiver/profile/account
flows lives in **`docs/waivers.md`**. The intended schema is defined by the
migrations in `supabase/migrations/*.sql`.

**When you change a migration, a table, or the code that reads/writes it,
update `docs/database.md` (and `docs/waivers.md` if the product behavior
changed) in the same change** so the docs and the code do not drift.

⚠️ **Committing a migration does not apply it.** Nothing in this pipeline runs
`supabase/migrations/*.sql` **against the live database** — Lovable applies only
the SQL its own agent writes. (`supabase-lint.yml` does replay every migration,
but onto a throwaway local Postgres: that proves a migration _can_ apply, not
that it _has_.) A migration file pushed through GitHub is inert until somebody
applies it to the live database (there is only one; no staging tier), which is
how `column waivers.approval_status does not exist` reached production with the
migration sitting merged in the repo.

**But do not apply it before the user has reviewed it.** Write the migration,
open the PR, and stop — spell out in the PR body what SQL is waiting to run.
Once the user approves, **apply the SQL, record it in
`supabase_migrations.schema_migrations`, verify the object exists, and reload
PostgREST — all before merging.** This holds for additive and destructive changes
alike: there is one database and no staging tier, so applying a migration is a
production change. Never merge a migration you have not applied, and never apply
one the user has not approved. See `docs/database-changes.md` for the full
procedure and the CI checks that catch both halves.

## Manager agent API

A small, token-authenticated HTTP endpoint that lets a manager's AI agent perform
a whitelisted set of manager actions against the live site. It is the "simplest
way to plug in an agent": a bearer token + JSON, wrappable as an MCP server or
driven directly by the bundled skill.

- **Endpoint:** `src/routes/api/manager/agent.ts`
  - `GET  /api/manager/agent` → the self-describing **manifest** (the runtime
    source of truth for the current action set).
  - `POST /api/manager/agent` with `{ "action", "params" }` → dispatch.
- **Auth:** `Authorization: Bearer <token>`. Tokens are **manager-issued and
  revocable** — a manager mints them at `/manager/api-tokens` (route
  `_authenticated/manager.api-tokens.tsx`). Only a SHA-256 hash is stored
  (`manager_api_tokens` table); the raw token is shown once at creation. On each
  request the endpoint looks the token up by hash, confirms it isn't revoked, and
  re-checks the owner still holds the `manager` role. A `MANAGER_AGENT_API_KEY`
  env var is accepted as an **optional break-glass fallback** (e.g. bootstrap /
  CI); it is not required. The endpoint runs actions with the service-role
  client, so a token grants manager-level access to the exposed actions — treat
  it as a secret.
  - Token management server functions: `src/lib/manager-api-tokens.functions.ts`
    (`listApiTokens` / `createApiToken` / `revokeApiToken`); token crypto +
    the paste-able agent prompt: `src/lib/manager-api-tokens.ts`.
  - The `/manager/api-tokens` screen also renders a copy-paste **agent prompt**
    (`buildAgentPrompt`) for Claude Code / opencode / Cursor and points at the
    `uts-manager-agent` skill.
- **Actions** (an "invoice" is a `memberships` row — its price/reference/status
  _are_ the invoice):
  - `list_users` — members and their lifecycle status, roles, and invoices.
  - `list_invoices` — invoices with member name/email (to find an id to edit).
  - `edit_invoice` — correct an invoice's detail fields. Cannot set `status` to
    `active` (activation grants the member role + emails the member, so it runs
    through bank reconciliation, not a raw edit).
- **Agent glue:** `.claude/skills/uts-manager-agent/` — a skill (with a `curl`
  helper) that documents how to call the endpoint. An MCP wrapper is equally
  simple: one tool per manifest action, forwarding to this endpoint.

### Keep these in sync

The action contract lives in **four** places — change all of them together, or
the agent glue drifts from the deployed API:

1. `src/lib/validation.ts` — `managerAgentActions` + the per-action Zod schemas.
2. `src/lib/manager-agent.ts` — `AGENT_MANIFEST` (self-description) + projections.
3. `src/routes/api/manager/agent.ts` — the request dispatch/handlers.
4. `.claude/skills/uts-manager-agent/SKILL.md` — the agent-facing docs.

`src/lib/manager-agent.test.ts` asserts the manifest matches `managerAgentActions`,
so a forgotten manifest update fails CI. The `GET` manifest is authoritative at
runtime: the skill instructs agents to read it before acting, so an MCP/skill
wrapper never needs hand-syncing beyond the human-readable docs above.

## Plans you show the user are product-level

Plans presented to the user (plan mode, an approach proposal, a check-in before
starting) describe **what changes for the people using the site**: who is
affected, which page or flow, what is different afterwards, what decisions are
theirs, and what is out of scope. Not file paths, table names, or migration
ordering. Work the implementation out separately and keep it as working notes,
the way `.lovable/plan.md` puts user-facing behavior first and the technical
section after. Full detail on request. See "Plans you show the user are
product-level" in `CLAUDE.md`.

## Writing style for website copy

This applies to all user-facing copy, not just the public marketing pages:
page headings, body text, CTAs, meta descriptions, toasts and banners on the
public site, and equally the authenticated member/manager pages and the
transactional emails (subjects, preview text, headings and body). All of it
must read like it was written by a person, not generated by an AI. Keep it
plain, warm and direct in the voice of a local Jiu-Jitsu club.

**Do not use the em dash (`—`) in prose.** It is the clearest tell of AI-written
copy. Rewrite it instead: split into two sentences, or use a comma, colon,
parentheses, or "and"/"but" as the sentence actually needs.

- ✅ `Your first two classes are free. No gear needed.`
- ✅ `Ask us by email, WhatsApp or phone. We're happy to help.`
- ❌ `Your first two classes are free — no gear needed.`

Also avoid other AI-prose tells in copy: hollow hype ("elevate", "unlock",
"seamless", "robust"), the "it's not just X, it's Y" and "whether you're X or Y"
constructions, and mechanical rule-of-three lists. Prefer concrete, specific
wording.

Exceptions (these are typography/UI, not prose, and are fine): an en dash (`–`)
in a numeric range such as `5:30 – 7:00pm`, and an em dash used as a
placeholder glyph for an empty value (e.g. `{value || "—"}`).

When you add or change any user-facing copy (public, authenticated, or email),
scan the diff for em dashes before committing.

## Recurring build gotchas (for future agents)

Two issues that have burned time recently. Fix these at the source, not by patching call sites over and over.

### 1. Supabase generated types go stale after a migration

Symptom (runtime, on the affected form): `Could not find the '<column>' column of '<table>' in the schema cache`. The migration ran, but `src/integrations/supabase/types.ts` (auto-generated) was not regenerated, so PostgREST rejects the insert against its cached schema view.

First rule out the more serious cause: a `column <table>.<column> does not exist` error is a different problem — the migration never reached the live database at all. See `docs/database-changes.md` before touching the types.

Fix: after any migration that adds/renames columns or tables, bring `src/integrations/supabase/types.ts` back in step in the same change, and run `NOTIFY pgrst, 'reload schema'` so PostgREST re-reads the schema. Only Lovable can truly regenerate the file; when it cannot (out of credits, say), hand-add **only** columns you have verified exist live, in the generator's own style. Also update `docs/database.md` per the project rule.

Do **not** reach for a `never`/`unknown` cast to silence a stale type. Those casts are what let `waivers.approval_status` be missing from production for a week with a green build — the cast disables the only check that would have caught it. Fix the types instead.

### 2. `.maybeSingle()` returns `T | null`, but helpers often take `T | undefined`

Symptom (typecheck, e.g. `src/routes/api/manager/agent.ts`): `Type 'null' is not assignable to type '{...} | undefined'` when passing a `.maybeSingle()` result into a helper whose optional parameter is typed `T | undefined` (default TS optional-parameter shape).

Fix at the call site: `helper(row, (plan ?? undefined) as PlanRow | undefined)`. Do NOT widen the helper signature to accept `null` just to silence one caller — `null` and `undefined` are semantically the same "no row" here and the helper's other callers already pass `undefined`. The `?? undefined` normalization keeps the boundary tidy.

Rule of thumb: Supabase `.maybeSingle()` / `.select().single()` speak `null`; TS optional params speak `undefined`. Normalize at the boundary.
