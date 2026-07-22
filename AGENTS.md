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
