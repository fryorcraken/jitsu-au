---
name: uts-manager-agent
description: >-
  Perform UTS Jitsu manager actions (list members and their status, edit an
  invoice's details) against the live site via its manager agent HTTP API. Use
  when a club manager asks an agent to look up members/invoices or correct
  invoice details (price, payment reference, notes, status). Requires the
  UTS_MANAGER_API_URL and UTS_MANAGER_API_KEY environment variables.
---

# UTS Jitsu — manager agent

This skill drives the club's **manager agent API** — a small, token-authenticated
JSON endpoint that exposes a whitelisted set of manager actions. It is the
simplest way to let an agent act for a manager: no login flow, just a bearer
token and `curl`.

The server code lives at `src/routes/api/manager/agent.ts`; the endpoint is
**self-describing**, so treat the live manifest — not this file — as the source
of truth for the current action set.

## Configuration

- `UTS_MANAGER_API_URL` — the site's base URL, e.g. `https://jitsu.au`
- `UTS_MANAGER_API_KEY` — the shared manager agent token (server env
  `MANAGER_AGENT_API_KEY`)

The endpoint is `POST $UTS_MANAGER_API_URL/api/manager/agent`. Every request
sends `Authorization: Bearer $UTS_MANAGER_API_KEY`.

A helper is provided: `scripts/agent.sh <action> [json-params]`.

## First: read the manifest

Always fetch the manifest before acting so you use the current action set and
parameter names:

```bash
curl -s "$UTS_MANAGER_API_URL/api/manager/agent" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" | jq
```

## Actions

All actions are `POST` with a body of `{ "action": "<name>", "params": { ... } }`.
Responses are `{ "ok": true, "action", "result" }` or
`{ "ok": false, "error": { "code", "message" } }`.

### `list_users` — list members and their status

Returns people known to the club (waiver signed and/or membership started) with
their `lifecycle_status` (`prospect | trial | member | expired`), `roles`, and
their `invoices` (each with an `id` you can pass to `edit_invoice`).

```bash
scripts/agent.sh list_users '{"status":"member","limit":50}'
# or raw:
curl -s "$UTS_MANAGER_API_URL/api/manager/agent" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"action":"list_users","params":{"status":"member"}}' | jq
```

`params` (all optional): `status` (lifecycle filter), `limit` (1–500, default 200).

### `list_invoices` — find an invoice to edit

Flat list of invoices (membership payment records) with member name/email.
`params` (optional): `status` (`pending | active | expired | cancelled`), `limit`.

```bash
scripts/agent.sh list_invoices '{"status":"pending"}'
```

### `edit_invoice` — correct an invoice's details

`params`: `id` (**required** — the invoice UUID from a list call) plus at least
one editable field: `price_cents` (integer cents), `notes`, `payment_reference`,
`payment_method` (`bank_transfer | stripe | manual`), `status`
(`pending | cancelled | expired`).

```bash
scripts/agent.sh edit_invoice '{"id":"<uuid>","price_cents":24500,"notes":"student rate applied"}'
```

> **You cannot set `status` to `active` here.** Activating a membership grants
> the member role and emails the member, so it must go through bank
> reconciliation / the manager UI — not a raw invoice edit.

## Guidance

- Confirm the target invoice with the manager (member name + amount) before an
  `edit_invoice` — it writes to live records.
- On `ok: false`, read `error.code`/`error.message`; `invalid_params` responses
  include an `issues` array pointing at the offending field.
