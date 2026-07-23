# Database (target model)

The schema reference for UTS Jitsu (Supabase Postgres).

> [!IMPORTANT]
> This document describes the **target** schema we are moving toward, not
> necessarily what is deployed today. The applied schema is always defined by the
> timestamped migrations in `supabase/migrations/*.sql` (source of truth). Where
> the target differs from what is currently applied, a **Changed from today**
> note calls it out. When you add or change a migration, update this file in the
> same change so the two do not drift.

## The core change this doc captures

Today a person's identity/contact details are **not** stored against the user.
They are captured on each `waivers` row (a full denormalised snapshot per signing)
and the app _derives_ a person by reading their latest waiver. Email, for example,
lives only in `waivers.email`.

The target inverts that:

- **Person data lives on the user** in a new `profiles` table (one row per user):
  identity, emergency contact, medical notes, guardian details, and SMS/WhatsApp
  consent.
- **A `waivers` row becomes just the signed artifact**: the generated PDF (path),
  provenance (`template_version`, `ip_hash`), approval, timestamps, and the link
  to the user. Individual acknowledgements and signatures are **not** stored as
  columns; they are captured inside the PDF.

## Conventions

- **RLS on every table.** Access is enforced by Row Level Security, not by the
  client. Public write paths validate field lengths/formats inside the policy
  `WITH CHECK`.
- **Three Supabase clients** decide who may write (see `CLAUDE.md` for the full
  table): the browser anon client (RLS as the user), the user-scoped server
  middleware `requireSupabaseAuth` (RLS as that user), and the service-role
  `supabaseAdmin` (bypasses RLS; server-only, used for trusted writes such as
  waiver inserts, PDF uploads, and signed URLs).
- **Roles** come from `user_roles` + the `app_role` enum, checked server-side via
  the `has_role(_user_id, _role)` security-definer function.
- **Money** is stored as integer cents. **Timestamps** are `timestamptz`.
- **Storage:** the private `waivers` bucket holds signature PNGs and PDFs; access
  is via short-lived service-role signed URLs. The bucket is provisioned outside
  SQL migrations.

---

## `auth.users` (Supabase-managed)

The identity/login record. Managed by Supabase Auth; not defined in our
migrations. Holds the canonical **login email** and `email_confirmed_at`. A
trigger (`handle_new_user_role`) grants `manager` to a confirmed whitelisted
address on signup. Every table below that references a user points at
`auth.users(id)`.

> Note the two emails in the system: `auth.users.email` is the **login identity**;
> `profiles.email` (below) is the person's **contact email** captured on a form.
> They may differ, and a person can have a contact email with no auth account.

---

## `profiles` 🔜 NEW — one row per person

The per-user record for identity and contact details. This is the new home for
everything the waiver row used to snapshot.

| Column                    | Type          | Null | Notes                                                        |
| ------------------------- | ------------- | ---- | ------------------------------------------------------------ |
| `user_id`                 | `uuid` PK     | no   | `REFERENCES auth.users(id) ON DELETE CASCADE`. One per user. |
| `first_name`              | `text`        | no   |                                                              |
| `middle_name`             | `text`        | yes  |                                                              |
| `last_name`               | `text`        | no   |                                                              |
| `full_name`               | `text`        | no   | Composed from the parts (maintained or a generated column).  |
| `date_of_birth`           | `date`        | no   |                                                              |
| `address`                 | `text`        | no   |                                                              |
| `phone`                   | `text`        | no   |                                                              |
| `email`                   | `text`        | no   | Contact email (see the `auth.users` note above).             |
| `uts_student_number`      | `text`        | yes  | Drives the student pricing rate.                             |
| `emergency_contact_name`  | `text`        | no   |                                                              |
| `emergency_contact_phone` | `text`        | no   |                                                              |
| `medical_notes`           | `text`        | yes  |                                                              |
| `is_minor`                | `boolean`     | no   | Default `false`.                                             |
| `guardian_name`           | `text`        | yes  | Required when `is_minor`.                                    |
| `guardian_relationship`   | `text`        | yes  | Required when `is_minor`.                                    |
| `sms_whatsapp_consent`    | `boolean`     | no   | Default `false`.                                             |
| `created_at`              | `timestamptz` | no   | Default `now()`.                                             |
| `updated_at`              | `timestamptz` | no   | Default `now()`.                                             |

**Not stored here:** the guardian's **signature** (typed name or drawn image) and
the participant's signature. Those are part of a signed waiver, so they live only
inside the generated PDF, never as profile columns.

**RLS (target):** a user reads and updates their own row (`auth.uid() = user_id`);
managers read all. Inserts/updates happen through a service-role server function
(the same path that writes a waiver), with a defence-in-depth owner policy
allowing a user to write only their own row. Field-length/format validation lives
in the `WITH CHECK` (mirroring the current waiver-insert validation).

**Changed from today:** this table does not exist yet. Its columns are moved off
`waivers`. Every reader that currently derives identity from the latest waiver
must repoint here (see [Migration notes](#migration-notes--repointing-identity-readers)).

---

## `waivers` 🔜 slimmed — the signed artifact

A signed waiver is now a pointer to the PDF plus provenance/approval/timestamps.
It carries **no person fields**.

| Column             | Type          | Null | Notes                                                                        |
| ------------------ | ------------- | ---- | ---------------------------------------------------------------------------- |
| `id`               | `uuid` PK     | no   | Default `gen_random_uuid()`.                                                 |
| `user_id`          | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. See the open decision below. |
| `pdf_path`         | `text`        | yes  | Path to the generated PDF in the `waivers` Storage bucket.                   |
| `template_version` | `int`         | yes  | Which `waiver_templates.version` was signed.                                 |
| `ip_hash`          | `text`        | yes  | Provenance. **Declared but not written by any code path today.**             |
| `approval_status`  | `text`        | no   | Default `'pending'`; `CHECK IN ('pending','approved')`.                      |
| `approved_at`      | `timestamptz` | yes  | NULL while pending.                                                          |
| `approved_by`      | `uuid`        | yes  | `REFERENCES auth.users(id) ON DELETE SET NULL`. The approving manager.       |
| `signed_at`        | `timestamptz` | no   | When the waiver was signed.                                                  |
| `created_at`       | `timestamptz` | no   | Default `now()`.                                                             |

**Removed from today's table** (moved to `profiles`, or captured inside the PDF):

- Identity → profile: `full_name`, `first_name`, `middle_name`, `last_name`,
  `date_of_birth`, `address`, `phone`, `email`, `uts_student_number`
- Emergency/medical → profile: `emergency_contact_name`, `emergency_contact_phone`,
  `medical_notes`
- Guardian → profile: `is_minor`, `guardian_name`, `guardian_relationship`
- Consent → profile: `sms_whatsapp_consent`
- Captured in the PDF only (not stored): `acknowledgements` (JSONB),
  `signature_name`, `signature_image_path`, `guardian_signature`,
  `guardian_signature_image_path`

**RLS (target):** unchanged in shape from today. Authenticated owners read their
own rows (`auth.uid() = user_id`); managers read all and may UPDATE (approval).
The public INSERT path stays but its `WITH CHECK` shrinks to the non-person
columns, since there are no longer person fields on the row to validate.

**Storage:** the PDF at `${waiver_id}.pdf`. Signature PNGs may still be uploaded
as inputs to PDF rendering, but their paths are no longer persisted on the row.

---

## `waiver_templates` ✅ unchanged

Versioned markdown waiver templates.

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

### `membership_plans` ✅ unchanged — manager-editable catalog

`id` PK, `code` (unique), `name`, `description`, `kind`
(`insurance|trial|session|period`), `public_price_cents`, `student_price_cents`,
`duration_days`, `session_credits`, `is_active`, `sort_order`, `created_at`.
**RLS:** anyone reads active plans; managers read all and write.

### `memberships` ✅ unchanged — enrollment/billing records

`id` PK, `user_id → auth.users(id) ON DELETE SET NULL`, `plan_id → membership_plans(id)`,
`status` (`pending|active|expired|cancelled`), `is_student`, `uts_student_number`,
`price_cents`, `payment_reference` (indexed; per-member, not unique),
`payment_method` (`bank_transfer|stripe|manual`), `paid_at`, `starts_at`,
`ends_at`, `sessions_remaining`, `session_date`, `notes`, `created_at`.
Constraint: student rate requires a `uts_student_number`. The `member` role is
granted on paid activation. **RLS:** users read own; managers read/update all;
direct member INSERT is revoked (all inserts go through the service-role
`startMembership`).

> `uts_student_number` is duplicated here for pricing. Once `profiles` exists it
> could reference the profile instead, but that is a later cleanup, out of scope
> for the person-data move.

### `bank_transactions` ✅ unchanged — statement import + reconciliation

`id` PK, `import_batch`, `posted_at`, `amount_cents`, `description`, `reference`,
`raw` (jsonb), `dedupe_hash` (unique, idempotent re-import),
`matched_membership_id → memberships(id)`, `matched_at`,
`matched_by → auth.users(id)`, `status` (`unmatched|matched|ignored`),
`created_at`. **RLS:** managers read; service role writes.

---

## Manager / infrastructure tables

### `user_roles` ✅ unchanged

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `role` (`app_role`:
`manager|member`), `created_at`, `UNIQUE(user_id, role)`. **RLS:** users read own;
managers read/insert/delete all. Checked via `has_role()`.

### `club_settings` ✅ unchanged — manager key/value store

`key` PK, `value`, `updated_at`, `updated_by → auth.users(id)`. First use:
markdown `invoice_payment_instructions`. **RLS:** manager-only.

### `manager_api_tokens` ✅ unchanged — manager agent API credentials

`id` PK, `label`, `token_prefix` (non-secret label), `token_hash` (SHA-256,
unique; raw token shown once), `created_by → auth.users(id)`, `created_at`,
`last_used_at`, `revoked_at`. Partial index on live tokens. **RLS:** manager-only;
auth/creation go through service-role server functions.

### `app_user_connections` ✅ unchanged — per-user connector credentials

`id` PK, `user_id → auth.users(id) ON DELETE CASCADE`, `connector_id`,
`connection_key_ciphertext`, `connected_email`, `metadata` (jsonb), `created_at`,
`updated_at`, `UNIQUE(user_id, connector_id)`. **RLS:** enabled; service role only.

### `waiver_drive_uploads` ✅ unchanged — per-manager Drive export tracking

`id` PK, `waiver_id → waivers(id) ON DELETE CASCADE`,
`manager_user_id → auth.users(id) ON DELETE CASCADE`, `drive_file_id`,
`drive_web_view_link`, `uploaded_at`, `UNIQUE(waiver_id, manager_user_id)`.
**RLS:** enabled; service role only.

---

## Public intake (anon insert-only)

### `interest_registrations` ✅ unchanged

`id` PK, `name`, `email`, `phone`, `uts_student`, `experience`, `message`,
`sms_whatsapp_consent`, `created_at`. **RLS:** anon INSERT under a validating
`WITH CHECK` (name/email/phone/experience/message length + email format).

### `contact_messages` ✅ unchanged

`id` PK, `name`, `email`, `subject`, `message`, `created_at`. **RLS:** anon INSERT
under a validating `WITH CHECK`.

> Both intake forms already collect a name/email/phone. When `profiles` exists,
> an interest registration could seed a profile, but that link is out of scope
> for the initial person-data move.

---

## Open design decision: anonymous signing

Today `/waiver` is a **public** route, `submitWaiverWithPdf` inserts via the
service-role client, and a waiver row may have `user_id = NULL` (the RLS INSERT
policy explicitly allows it). An anonymous visitor can fully sign a waiver and
receive their PDF via an inline signed URL.

A per-user `profiles` model needs a user to hang person data on, so anonymous
signing has to be resolved. Options (to decide before implementing):

- **(A) Require an account to sign.** Cleanest for the profile model; a profile
  row always exists. Drops anonymous signing (the biggest UX/product change).
- **(B) Keep anonymous signing; PDF-only for anon.** An anon waiver keeps
  `user_id = NULL` and no `profiles` row; the person's details live only inside
  the PDF until they create an account and a profile is populated. Least
  disruptive; managers still get the signed PDF, but anon signers are absent from
  the profile-derived member directory (which already excludes `user_id = NULL`).
- **(C) Standalone profile for anon.** Auto-create a profile not FK-locked to
  `auth.users` (e.g. a separate `profile_id`), later claimable by an account.
  Most flexible, most schema/plumbing work.

---

## Migration notes — repointing identity readers

Because identity is currently derived from the latest waiver per `user_id`, moving
it to `profiles` requires repointing every reader and both writers:

- **Writers:** `src/lib/waiver.functions.ts` — `submitWaiverWithPdf` (upsert the
  profile, then insert the slim waiver) and `getMyLatestWaiver` (read the profile
  for prefill instead of the last waiver). The alternate
  `src/lib/submissions.functions.ts` `submitWaiver` (no-PDF path) also writes
  person columns and must change or be retired.
- **Readers of identity-from-waiver:**
  - `src/lib/club-users.ts` — the synthetic `ClubUser` aggregation (name/email/
    phone) reads from `profiles`.
  - `src/lib/membership.functions.ts` — display name/email/phone, student number,
    and the surname-derived payment reference read from `profiles`.
  - `src/routes/api/manager/agent.ts` — `list_users` and `list_invoices` resolve
    member name/email from `profiles`.
  - `src/lib/google-drive.functions.ts` — the Drive export filename (`full_name`)
    reads from `profiles`.
- **Validation:** `src/lib/validation.ts` — split the waiver schema into a
  profile schema (person fields) and a slim waiver schema; update
  `src/lib/validation.test.ts` accordingly.
- **Backfill:** a migration to create `profiles` and seed one row per `user_id`
  from that user's latest waiver, before dropping the person columns from
  `waivers`.

This section is the checklist for the follow-up implementation; it is not
implemented by this document.
