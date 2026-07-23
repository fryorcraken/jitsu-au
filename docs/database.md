# Database

The schema reference for UTS Jitsu (Supabase Postgres).

> [!IMPORTANT]
> This document describes the schema and must stay aligned with the code. The
> applied schema is defined by the timestamped migrations in
> `supabase/migrations/*.sql` (the source of truth). **Whenever you change a
> migration, a table, or the code that reads/writes it, update this document in
> the same change** so the doc, the migrations, and the code never drift apart.

## People and waivers: the shape

A person is stored **once**, in `profiles`, keyed by their **email**. A waiver is
just the signed document: a PDF plus who signed it (a link to the profile), when,
from what IP, on which template version, and its approval state. The signer's
name, contact details, medical notes and guardian details are **not** copied onto
each waiver. They live on the one profile.

- **Signing a waiver is public. No account, no login.** The only hard requirement
  is an email. On submit, the server finds-or-creates the profile for that email,
  updates its details, and inserts a waiver linked to it.
- **One email field in the whole system:** `profiles.email`. It is the person's
  identity. `auth.users.email` is only the login credential for the optional
  member-area account; a profile links to it via `profiles.user_id` if and when
  the person ever signs in.
- **No stored full name.** `first/middle/last` are stored; the display name is
  composed on read (`composeFullName`).
- **No duplicated identity.** A person who signs several waivers has one profile;
  each new signing updates that profile and adds a waiver row.

### How the cases resolve

1. **Walk-in, no account** — name + email + details → new profile (`user_id` null)
   → waiver. No login.
2. **Same person signs again** — matched by email → existing profile updated in
   place → new waiver. Identity stored once.
3. **Later makes an account** — an auth account created with the same email is
   linked to the existing profile (`profiles.user_id` set by the signup trigger).
4. **Makes an account first, then signs** — the signup trigger already created the
   profile (name/email/phone); the waiver form fills in the rest.
5. **Minor** — the participant's profile is marked `is_minor` with guardian
   name/relationship; the guardian's signature is captured inside the PDF only.
6. **Manager view / agent API** — name, email and phone are read from the profile
   (one source), with the person's waivers and memberships hanging off it.

## Conventions

- **RLS on every table.** Access is enforced by Row Level Security, not the client.
- **Three Supabase clients** decide who may write (see `CLAUDE.md`): the browser
  anon client (RLS as the user), the user-scoped server middleware
  `requireSupabaseAuth` (RLS as that user), and the service-role `supabaseAdmin`
  (bypasses RLS; server-only). Public waiver signing runs through `supabaseAdmin`,
  so it needs no anon insert grant.
- **Roles** come from `user_roles` + the `app_role` enum, checked server-side via
  `has_role(_user_id, _role)`.
- **Money** is integer cents. **Timestamps** are `timestamptz`. **Emails** are
  stored lowercased/trimmed so the unique key dedupes case variants.
- **Storage:** the private `waivers` bucket holds the signed PDFs; access is via
  short-lived service-role signed URLs. The bucket is provisioned outside SQL
  migrations.

---

## `profiles` — one row per person, keyed by email

The single home for a person's identity and contact details.

| Column                    | Type          | Null | Notes                                                          |
| ------------------------- | ------------- | ---- | -------------------------------------------------------------- |
| `id`                      | `uuid` PK     | no   | Default `gen_random_uuid()`.                                   |
| `email`                   | `text`        | no   | `UNIQUE`. Lowercased/trimmed. The person's identity + the one email field. |
| `user_id`                 | `uuid`        | yes  | `UNIQUE`, `REFERENCES auth.users(id) ON DELETE SET NULL`. Set when the person has a member-area account. |
| `first_name`              | `text`        | yes  | Present for form/signup-created profiles; nullable for a bare magic-link account with no name yet. |
| `middle_name`             | `text`        | yes  |                                                                |
| `last_name`               | `text`        | yes  |                                                                |
| `date_of_birth`           | `date`        | yes  |                                                                |
| `address`                 | `text`        | yes  |                                                                |
| `phone`                   | `text`        | yes  |                                                                |
| `uts_student_number`      | `text`        | yes  | Drives the student pricing rate.                               |
| `emergency_contact_name`  | `text`        | yes  |                                                                |
| `emergency_contact_phone` | `text`        | yes  |                                                                |
| `medical_notes`           | `text`        | yes  |                                                                |
| `is_minor`                | `boolean`     | no   | Default `false`.                                               |
| `guardian_name`           | `text`        | yes  | Present when `is_minor`.                                       |
| `guardian_relationship`   | `text`        | yes  | Present when `is_minor`.                                       |
| `sms_whatsapp_consent`    | `boolean`     | no   | Default `false`.                                               |
| `created_at`              | `timestamptz` | no   | Default `now()`.                                               |
| `updated_at`              | `timestamptz` | no   | Default `now()`.                                               |

**Not stored here:** any signature (participant or guardian). Signatures are part
of a signed waiver, so they live only inside the generated PDF, never as columns.

**Created/updated by:** the public waiver submit (`submitWaiverWithPdf`, service
role, upsert by `email`) and the `handle_new_user_profile` trigger on
`auth.users` insert (links an existing profile by email, or creates one from the
signup metadata).

**RLS:** a person reads/updates their own profile (`auth.uid() = user_id`);
managers read all. Writes go through the service role; a defence-in-depth owner
policy lets a signed-in user update only their own row.

---

## `waivers` — the signed artifact

A waiver is the PDF plus provenance, approval, timestamps, and a link to the
person. It carries **no** identity columns.

| Column             | Type          | Null | Notes                                                          |
| ------------------ | ------------- | ---- | -------------------------------------------------------------- |
| `id`               | `uuid` PK     | no   | Default `gen_random_uuid()`.                                   |
| `profile_id`       | `uuid`        | no   | `REFERENCES profiles(id) ON DELETE CASCADE`. Who signed it.    |
| `pdf_path`         | `text`        | yes  | Path to the generated PDF in the `waivers` Storage bucket.     |
| `template_version` | `int`         | yes  | Which `waiver_templates.version` was signed.                   |
| `signer_ip`        | `text`        | yes  | The signer's real IP, kept as a forensic/legal record.         |
| `approval_status`  | `text`        | no   | Default `'pending'`; `CHECK IN ('pending','approved')`.        |
| `approved_at`      | `timestamptz` | yes  | NULL while pending.                                            |
| `approved_by`      | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. Approving manager. |
| `signed_at`        | `timestamptz` | no   | When the waiver was signed.                                    |
| `created_at`       | `timestamptz` | no   | Default `now()`.                                               |

**RLS:** the owner reads their own waivers (via their profile:
`profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())`); managers
read all and UPDATE (approval). Inserts go through the service role (public
signing); there is no anon insert grant.

**Storage:** the signed PDF at `${waiver_id}.pdf`. The submitted signature images
are rendered into the PDF and not otherwise persisted.

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
Constraint: the student rate requires a `uts_student_number`. The `member` role is
granted on paid activation. Membership belongs to an auth account; the member's
name/email for display is read from their profile (via `user_id`). **RLS:** users
read own; managers read/update all; direct member INSERT is revoked (all inserts
go through the service-role `startMembership`).

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
`manager|member`), `created_at`, `UNIQUE(user_id, role)`. **RLS:** users read own;
managers read/insert/delete all. Checked via `has_role()`.

### `club_settings` — manager key/value store

`key` PK, `value`, `updated_at`, `updated_by → auth.users(id)`. First use:
markdown `invoice_payment_instructions`. **RLS:** manager-only.

### `manager_api_tokens` — manager agent API credentials

`id` PK, `label`, `token_prefix`, `token_hash` (SHA-256, unique; raw shown once),
`created_by → auth.users(id)`, `created_at`, `last_used_at`, `revoked_at`. Partial
index on live tokens. **RLS:** manager-only; auth/creation via service-role
functions.

### `app_user_connections` — per-user connector credentials

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `connector_id`,
`connection_key_ciphertext`, `connected_email`, `metadata` (jsonb), `created_at`,
`updated_at`, `UNIQUE(user_id, connector_id)`. **RLS:** enabled; service role only.

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

`id` PK, `name`, `email`, `subject`, `message`, `created_at`. **RLS:** anon INSERT
under a validating `WITH CHECK`.

---

## `auth.users` (Supabase-managed)

The optional login account, managed by Supabase Auth (not in our migrations).
Holds the login email and `email_confirmed_at`. Two triggers fire on insert:
`handle_new_user_role` (grants `manager` to a confirmed whitelisted address) and
`handle_new_user_profile` (links or creates the person's `profiles` row by email).
`profiles.user_id`, `memberships.user_id`, `user_roles.user_id` and the various
`*_by` columns all reference it.
