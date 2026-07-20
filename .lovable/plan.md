
## Goal

Turn the waiver flow into a real, signed PDF document. Managers can edit the waiver text (with placeholders like `{{full_name}}`). Members who are signed in get their form auto-filled from their previous waiver / profile. Every submission produces a stored PDF that both the member and managers can download.

Note: the existing utsjitsu.com.au site outsources signup to Gymdesk and has no in-house waiver, so nothing to mirror. This plan uses the current `/waiver` form as the baseline.

## What we'll build

### 1. Editable waiver template (manager-controlled)

- New table `waiver_templates` (versioned): `id`, `version` (int, unique, auto), `body_md` (text, markdown with `{{placeholder}}` tokens), `title`, `is_current` (bool), `created_by`, `created_at`.
- Only managers can insert/update; anyone can read the current template (needed to render on the public waiver page).
- Supported placeholders: `{{full_name}}`, `{{date_of_birth}}`, `{{address}}`, `{{phone}}`, `{{email}}`, `{{emergency_contact_name}}`, `{{emergency_contact_phone}}`, `{{medical_notes}}`, `{{signature_name}}`, `{{signed_date}}`, `{{club_name}}`.
- Seed migration inserts version 1 with the current hard-coded acknowledgement text converted to markdown + placeholders.

### 2. Manager editor UI

- New route `/_authenticated/manager/waiver-template`:
  - Textarea (markdown) with a live preview panel that substitutes placeholders with sample values.
  - Placeholder cheat-sheet sidebar (click to insert).
  - "Save as new version" button — never overwrites past versions (so historical signed waivers keep their exact text).
- Add a link to it from `/account` manager card.

### 3. Public waiver page changes

- Fetch current template server-side, render the body as read-only markdown above the form fields.
- If the visitor is signed in, prefill form fields from their most recent waiver (fetched via a new `getMyLatestWaiver` server fn).
- Keep the existing form fields, acknowledgements, and typed-signature.

### 4. PDF generation + storage

- On submit, server fn `submitWaiver`:
  1. Loads current template row, records its `template_version` on the waiver.
  2. Substitutes placeholders with submitted values.
  3. Renders a PDF using `pdf-lib` (pure JS, works in the Cloudflare Worker runtime — `pdfkit`/`puppeteer` do not). Layout: club logo + title, rendered waiver body, filled details table, acknowledgements ticked, typed signature + timestamp + IP hash.
  4. Uploads to a private storage bucket `waivers/{waiver_id}.pdf` using `supabaseAdmin`.
  5. Stores `pdf_path` and `template_version` on the `waivers` row; optionally links `user_id` when signer is authenticated.
- Waiver confirmation page gets a "Download your signed waiver" button (signed URL, 1h TTL).

### 5. Schema changes to `waivers`

Add columns: `user_id uuid null` (fk auth.users), `template_version int not null`, `pdf_path text`, `ip_hash text null`.
Add policies:
- Authenticated user can SELECT their own rows (`auth.uid() = user_id`).
- Managers can SELECT all rows.
- Keep the existing anon INSERT policy.

### 6. Manager waiver list

- New route `/_authenticated/manager/waivers`: paginated table of waivers with download link (signed URL from a `getWaiverPdfUrl` server fn gated by `has_role('manager')`).

## Technical details

- **PDF library**: `pdf-lib` (Worker-compatible). Font: embed DejaVu-like via `@pdf-lib/fontkit` only if we need unicode; MVP uses built-in Helvetica.
- **Storage bucket**: private, created via `supabase--storage_create_bucket`. RLS on `storage.objects` restricts SELECT to managers + owner via `user_id` path prefix; downloads always go through a server fn that mints a signed URL, so bucket policies can be manager-only.
- **Template rendering**: simple `body.replace(/{{(\w+)}}/g, ...)`; unknown tokens left as-is with a lint warning in the editor preview.
- **Versioning**: every save inserts a new row and flips `is_current`; old versions retained so re-generating a PDF for an old waiver uses the exact text signed.
- **Autofill**: `getMyLatestWaiver` server fn (`requireSupabaseAuth`) returns the newest waiver row's contact fields; the client pre-populates form defaults.
- **Anon signers**: still allowed. `user_id` stays null; the PDF is still generated and emailed/linked on the thank-you page via a short-lived signed URL returned from `submitWaiver`.

## Out of scope for this iteration

- Drawn (canvas) signatures — keep typed-name signature.
- Emailing the PDF to the signer (can add later once auth email domain is verified).
- Editing placeholders list from the UI (fixed set for now).
