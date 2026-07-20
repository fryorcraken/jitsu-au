## Waiver form improvements

Three coordinated changes to `/waiver` and its backend.

### 1. Split full name into three fields

Replace the single "Full name" input with:

- First name (required)
- Middle name (optional)
- Last name (required)

`full_name` is still used everywhere downstream (PDF, template placeholder `{{full_name}}`, admin list, prefill). We keep a computed `full_name = [first, middle, last].filter(Boolean).join(" ")` so nothing else has to change. The `waivers` table gains three new columns (`first_name`, `middle_name`, `last_name`) so the form can prefill them on return visits; `full_name` stays as the canonical display column.

### 2. Live PDF preview in the form

Replace the current markdown block with a live PDF preview embedded in the form that updates as the user types.

- Client-side PDF generation using `pdf-lib` (already a project dep) built in a new `src/lib/waiver-pdf-client.ts` that mirrors the server layout. Shared layout helper so preview and signed PDF stay visually identical.
- Rendered into an `<iframe>` via a blob URL, sized responsively (roughly A4 aspect, capped height with scroll). Debounced regeneration (~250 ms) on field changes.
- Shows a "DRAFT — NOT SIGNED" watermark until the user submits. On submit the server still generates the authoritative signed PDF (with signature image, timestamp, IP).
- The waiver template markdown is rendered into the PDF preview itself, so the user sees the actual document they are signing rather than a separate markdown block above.

### 3. Signature: draw or type

Add a tabbed signature control with two tabs, "Draw" and "Type":

- Draw: HTML canvas pad using `signature_pad` (small, well-maintained lib). Mouse + touch. Clear button. Exports a trimmed PNG data URL.
- Type: current typed-name input.
- User picks either; submit requires one of them. Same UX for the guardian signature block when the participant is under 18.

Backend stores the drawn signature as an image in the waiver PDF (embedded via `pdf-lib`) and persists the PNG bytes to the existing `waivers` storage bucket alongside the PDF, so managers can see the actual mark. Typed signatures continue to render as text.

### Technical details

Files touched:

- `src/routes/waiver.tsx` — name fields split, live PDF preview iframe, signature tabs, guardian signature tabs.
- `src/lib/waiver-pdf-client.ts` (new) — client-safe layout used by the preview.
- `src/lib/waiver-pdf.server.ts` — accept optional signature PNG(s), embed as image; share layout constants with the client helper via a shared `waiver-pdf-layout.ts`.
- `src/lib/waiver.functions.ts` — accept `first_name`, `middle_name`, `last_name`, `signature_image` (base64 PNG, optional), `guardian_signature_image` (optional). Validate that at least one of typed/drawn signature is present. Compose `full_name` server-side.
- `src/routes/_authenticated/manager.waivers.tsx` — no schema-visible change; still shows `full_name`.
- New dependency: `signature_pad` (~5 KB).
- Migration: add `first_name text`, `middle_name text`, `last_name text`, `signature_image_path text`, `guardian_signature_image_path text` to `public.waivers` (all nullable for back-compat).

Validation rules:

- First and last name: 1–60 chars each.
- Middle name: 0–60 chars.
- Signature: either `signature_name` (typed) OR `signature_image` (drawn) must be non-empty; same rule for guardian when `is_minor`.

Out of scope: changes to the manager waiver template editor, the account page, or other routes.
