# Database

The schema reference for UTS Jitsu (Supabase Postgres).

> [!IMPORTANT]
> This document describes the schema and must stay aligned with the code. The
> applied schema is defined by the timestamped migrations in
> `supabase/migrations/*.sql` (the source of truth). **Whenever you change a
> migration, a table, or the code that reads/writes it, update this document in
> the same change** so the doc, the migrations, and the code never drift apart.
> The product flows behind the person/waiver tables live in `docs/waivers.md`.

## People and waivers: the shape

A person is stored **once**, in `profiles`, keyed by their **email**. A waiver
is a **frozen submission**: exactly what was typed (person fields as submitted),
the signed PDF, the template version, the signer's real IP, and its approval
state. A manager's **approval** copies the submission's details onto the
profile and provisions the person's login (see `docs/waivers.md`). The profile
is the only live record; waiver rows are history/evidence.

- **Signing is public**: no account, no login; only an email is required.
  Submissions are unlimited; the person's **active** waiver is the latest
  approved one (derived, not stored).
- **One canonical email**: `profiles.email` — the only email the app reads.
  `waivers.email` is part of the frozen submission. `auth.users.email` is the
  login credential, write-once: copied from the profile at provisioning, never
  edited on its own (no self-serve email change), read only as a fallback for
  accounts that predate any profile.
- **No stored full name** anywhere; composed from `first/middle/last` on read
  (`composeFullName` / `profileFullName`).

## Conventions

- **RLS on every table.** Access is enforced by Row Level Security, not the client.
- **Three Supabase clients** decide who may write (see `CLAUDE.md`): the browser
  anon client (RLS as the user), the user-scoped server middleware
  `requireSupabaseAuth` (RLS as that user), and the service-role `supabaseAdmin`
  (bypasses RLS; server-only). Waiver submission and approval both run through
  `supabaseAdmin`, so `profiles`/`waivers` need no public insert grants.
- **Roles** come from `user_roles` + the `app_role` enum, checked server-side via
  `has_role(_user_id, _role)`.
- **Money** is integer cents. **Timestamps** are `timestamptz`. **Emails** are
  stored lowercased/trimmed so the unique key dedupes case variants.
- **Storage:** the private `waivers` bucket holds the signed PDFs; access is via
  short-lived service-role signed URLs. The bucket is provisioned outside SQL
  migrations.

---

## `profiles` — one row per person, keyed by email

Starts as a lightweight visitor profile (email, maybe name/phone) created at
first waiver submission; filled in by manager approval; linked to a login when
approval provisions one.

| Column                    | Type          | Null | Notes                                                                                                          |
| ------------------------- | ------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                                                   |
| `email`                   | `text`        | no   | `UNIQUE`. Lowercased/trimmed. The person's identity + the one canonical email.                                 |
| `user_id`                 | `uuid`        | yes  | `UNIQUE`, `REFERENCES auth.users(id) ON DELETE SET NULL`. Set when approval provisions (or links) their login. |
| `first_name`              | `text`        | yes  |                                                                                                                |
| `middle_name`             | `text`        | yes  |                                                                                                                |
| `last_name`               | `text`        | yes  |                                                                                                                |
| `date_of_birth`           | `date`        | yes  |                                                                                                                |
| `address`                 | `text`        | yes  |                                                                                                                |
| `phone`                   | `text`        | yes  |                                                                                                                |
| `uts_student_number`      | `text`        | yes  | Drives the student pricing rate.                                                                               |
| `emergency_contact_name`  | `text`        | yes  |                                                                                                                |
| `emergency_contact_phone` | `text`        | yes  |                                                                                                                |
| `medical_notes`           | `text`        | yes  |                                                                                                                |
| `is_minor`                | `boolean`     | no   | Default `false`.                                                                                               |
| `guardian_name`           | `text`        | yes  |                                                                                                                |
| `guardian_relationship`   | `text`        | yes  |                                                                                                                |
| `sms_whatsapp_consent`    | `boolean`     | no   | Default `false`.                                                                                               |
| `created_at`              | `timestamptz` | no   | Default `now()`.                                                                                               |
| `updated_at`              | `timestamptz` | no   | Default `now()`.                                                                                               |

**Not stored here:** signatures (participant or guardian) — they live only
inside the waiver PDF — and no `full_name`.

**Written by (service role only):**

- Waiver submission (`submitWaiverWithPdf`): creates the visitor profile for a
  new email (email, name parts, phone). An existing profile is left untouched.
- Manager approval (`setWaiverApproval`): copies the approved submission's
  person fields onto the profile (`waiverToProfileFields`) and sets `user_id`
  when it provisions/links the login.
- `handle_new_user_profile()` trigger on `auth.users` (SECURITY DEFINER,
  EXECUTE revoked from PUBLIC/anon/authenticated): a **link-only safety net**
  that attaches an unlinked profile to a new auth user by email, and only once
  the email is **confirmed** (`email_confirmed_at`). It never creates profiles.

**RLS:** owner reads/updates own row (`auth.uid() = user_id`); managers
read/update all; no public insert path.

---

## `waivers` — frozen submissions

| Column                    | Type          | Null | Notes                                                                                                                                                                                                           |
| ------------------------- | ------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                                                                                                                                                    |
| `profile_id`              | `uuid`        | no   | `REFERENCES profiles(id) ON DELETE CASCADE`. Set at submission (visitor profile is created first). Indexed.                                                                                                     |
| `first_name`              | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `middle_name`             | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `last_name`               | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `date_of_birth`           | `date`        | no   | As submitted.                                                                                                                                                                                                   |
| `address`                 | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `phone`                   | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `email`                   | `text`        | no   | As submitted (normalized). Part of the frozen record.                                                                                                                                                           |
| `uts_student_number`      | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `sms_whatsapp_consent`    | `boolean`     | no   | As submitted.                                                                                                                                                                                                   |
| `emergency_contact_name`  | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `emergency_contact_phone` | `text`        | no   | As submitted.                                                                                                                                                                                                   |
| `medical_notes`           | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `is_minor`                | `boolean`     | no   | As submitted.                                                                                                                                                                                                   |
| `guardian_name`           | `text`        | yes  | As submitted (required for minors by validation).                                                                                                                                                               |
| `guardian_relationship`   | `text`        | yes  | As submitted.                                                                                                                                                                                                   |
| `pdf_path`                | `text`        | yes  | The signed PDF in the `waivers` Storage bucket.                                                                                                                                                                 |
| `template_version`        | `int`         | yes  | Which `waiver_templates.version` was signed.                                                                                                                                                                    |
| `signer_ip`               | `text`        | yes  | The signer's real IP (legal/forensic record).                                                                                                                                                                   |
| `signer_meta`             | `jsonb`       | no   | Default `'{}'`. Signing-context evidence: request headers (user agent, language, client hints) + browser-reported timezone/screen/viewport/platform/languages (`buildSignerMeta`). Never copied to the profile. |
| `approval_status`         | `text`        | no   | Default `'pending'`; `CHECK IN ('pending','approved')`.                                                                                                                                                         |
| `approved_at`             | `timestamptz` | yes  | NULL while pending.                                                                                                                                                                                             |
| `approved_by`             | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Approving manager.                                                                                                                                              |
| `signed_at`               | `timestamptz` | no   | When the waiver was signed.                                                                                                                                                                                     |
| `created_at`              | `timestamptz` | no   | Default `now()`.                                                                                                                                                                                                |

**Not stored:** `full_name`, signatures (typed or drawn), acknowledgement ticks
— all captured inside the PDF only. The displayed **pending / active /
superseded** status is derived in the app (`deriveWaiverListStatuses`): per
profile, the latest approved waiver is active.

**RLS:** owner reads their own via their profile
(`profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())`);
managers read all and UPDATE (approval). Inserts are service-role only.

---

## `waiver_templates` — versioned markdown templates

| Column             | Type          | Null | Notes                                                  |
| ------------------ | ------------- | ---- | ------------------------------------------------------ |
| `id`               | `uuid` PK     | no   |                                                        |
| `version`          | `int`         | no   | `UNIQUE`.                                              |
| `title`            | `text`        | no   | Default `'Training Waiver'`.                           |
| `body_md`          | `text`        | no   | Uses `{{placeholder}}` tokens (e.g. `{{full_name}}`).  |
| `acknowledgements` | `jsonb`       | no   | Default `'[]'`. `[{id,label,required}]` checkbox defs. |
| `is_current`       | `boolean`     | no   | Partial unique index enforces exactly one `true`.      |
| `created_by`       | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`.        |
| `created_at`       | `timestamptz` | no   |                                                        |

**RLS:** anyone reads the current template; managers read all and insert/update.

---

## Membership ledger

### `membership_plans` — manager-editable catalog

`id` PK, `code` (unique), `name`, `description`, `kind`
(`insurance|trial|session|period`), `public_price_cents`, `student_price_cents`,
`duration_days`, `session_credits`, `is_active`, `sort_order`, `created_at`.
**RLS:** anyone reads active plans; managers read all and write.

### `memberships` — enrollment/billing records

`id` PK, `user_id → auth.users(id) ON DELETE SET NULL`,
`plan_id → membership_plans(id)`, `status`
(`pending|active|expired|cancelled`), `is_student`, `uts_student_number`,
`price_cents`, `payment_reference` (indexed; per-member, not unique),
`payment_method` (`bank_transfer|stripe|manual`), `paid_at`, `starts_at`,
`ends_at`, `sessions_remaining`, `session_date`, `notes`, `created_at`.
Constraint: the student rate requires a `uts_student_number`. The `member` role
is granted on paid activation. The member's display name/email come from their
profile (via `user_id`). **RLS:** users read own; managers read/update all;
direct member INSERT is revoked (all inserts go through the service-role
`startMembership`).

### `bank_transactions` — statement import + reconciliation

`id` PK, `import_batch`, `posted_at`, `amount_cents`, `description`, `reference`,
`raw` (jsonb), `dedupe_hash` (unique), `matched_membership_id → memberships(id)`,
`matched_at`, `matched_by → auth.users(id)`, `status`
(`unmatched|matched|ignored`), `created_at`. **RLS:** managers read; service role
writes.

---

## Manager / infrastructure tables

### `user_roles`

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `role` (`app_role`:
`manager|member`), `created_at`, `UNIQUE(user_id, role)`. **RLS:** users read
own; managers read/insert/delete all. Checked via `has_role()`.

### `club_settings` — manager key/value store

`key` PK, `value`, `updated_at`, `updated_by → auth.users(id)`. First use:
markdown `invoice_payment_instructions`. **RLS:** manager-only.

### `manager_api_tokens` — manager agent API credentials

`id` PK, `label`, `token_prefix`, `token_hash` (SHA-256, unique; raw shown once),
`created_by → auth.users(id)`, `created_at`, `last_used_at`, `revoked_at`.
Partial index on live tokens. **RLS:** manager-only; auth/creation via
service-role functions.

### `app_user_connections` — per-user connector credentials

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `connector_id`,
`connection_key_ciphertext`, `connected_email`, `metadata` (jsonb),
`created_at`, `updated_at`, `UNIQUE(user_id, connector_id)`. **RLS:** enabled;
service role only.

### `waiver_drive_uploads` — per-manager Drive export tracking

`id` PK, `waiver_id → waivers(id) ON DELETE CASCADE`,
`manager_user_id → auth.users(id) ON DELETE CASCADE`, `drive_file_id`,
`drive_web_view_link`, `uploaded_at`, `UNIQUE(waiver_id, manager_user_id)`.
**RLS:** enabled; service role only.

---

## Public intake (anon insert-only)

### `interest_registrations`

`id` PK, `name`, `email`, `phone`, `uts_student`, `experience`, `message`,
`sms_whatsapp_consent`, `created_at`. **RLS:** anon INSERT under a validating
`WITH CHECK` (name/email/phone/experience/message length + email format).

### `contact_messages`

`id` PK, `name`, `email`, `subject`, `message`, `created_at`. **RLS:** anon
INSERT under a validating `WITH CHECK`.

---

## `auth.users` (Supabase-managed)

The login account, managed by Supabase Auth (not in our migrations). Accounts
are provisioned by waiver approval (`inviteUserByEmail`), not self-serve
sign-up. Two triggers fire on insert/confirmation:

- `handle_new_user_role` — grants `manager` to a confirmed whitelisted address.
- `handle_new_user_profile` — link-only safety net: attaches an unlinked
  profile by **confirmed** email. EXECUTE is revoked from the public RPC
  surface.

`profiles.user_id`, `memberships.user_id`, `user_roles.user_id` and the various
`*_by` columns reference it.
