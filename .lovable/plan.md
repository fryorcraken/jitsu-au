Two-milestone build. This plan covers **Milestone 1: the public landing page + form capture**. Membership accounts, Stripe billing, gear sales, and the coach admin dashboard are scoped for Milestone 2 (outlined at the bottom so we agree on direction).

## Milestone 1 — Public landing page

### Pages (TanStack Start routes)
- `/` — Home: hero, value props, CTAs, schedule preview, testimonials, FAQ teaser, footer
- `/about` — Club story, Sensei Franck bio, approach to self-defence, community, fitness
- `/classes` — Schedule (Mon/Wed/Sat), location (ActivateFit Gym, Ultimo), what to expect, what to bring
- `/pricing` — UTS student vs general public fees, yearly membership, uniform, trial offer
- `/faq` — Full FAQ from current site
- `/register-interest` — Form (name, email, phone, UTS student y/n, experience, message)
- `/waiver` — Digital waiver (personal + emergency contact + medical + typed-signature + date)
- `/contact` — Contact form + phone, WhatsApp, socials
- `/thank-you` — Shared success page

Each route sets its own `head()` metadata (title, description, og tags). Global nav + footer live in `__root.tsx`.

### Design
Match the existing utsjitsu.com.au vibe: clean, welcoming, blue accent, white background, friendly photography. Semantic tokens in `src/styles.css` (primary = jitsu blue, warm accents). Responsive mobile-first (user is on 390px viewport).

### Content
Reused verbatim/adapted from utsjitsu.com.au: approach, community, fitness, instructor bio, schedule, fees, FAQ, contact details (0493 631 759, WhatsApp, socials, ActivateFit Gym location). Placeholder imagery until real photos supplied.

### Forms & data (Lovable Cloud)
Enable Lovable Cloud. Create three tables with RLS:
- `interest_registrations` — name, email, phone, uts_student, experience, message, created_at
- `waivers` — full name, dob, address, emergency contact name/phone, medical notes, acknowledgements (jsonb), signature_name, signed_at, ip
- `contact_messages` — name, email, subject, message, created_at

Public inserts allowed (anon INSERT policy, no SELECT for anon). Admins will read them in Milestone 2. Zod validation client + server, honeypot field for spam.

### Out of scope for Milestone 1
Auth, member accounts, payments, gear store, admin dashboard, email notifications (can add SendGrid/Resend later).

## Technical details
- Stack: existing TanStack Start + Tailwind v4 + shadcn (no framework changes)
- Replace placeholder `src/routes/index.tsx` with real home
- Shared `<SiteHeader />` and `<SiteFooter />` in `src/components/site/`
- Form submissions via `createServerFn` writing to Supabase (publishable client for inserts under a scoped `TO anon` INSERT policy) — no auth required
- One migration creates all 3 tables + GRANTs + RLS policies

## Milestone 2 preview (not built in this plan)
- Member auth (email/password + Google) via Lovable Cloud
- `profiles`, `memberships`, `payments`, `products` (gear), `orders` tables
- Stripe (built-in Lovable Payments): per-session ($20/$30), per-semester ($245/$445), yearly membership ($60), uniform ($90), gear catalog, save-card for auto-debit
- Coach admin dashboard: members list, waiver viewer, membership status, payment history, mark attendance
- Role-based access using `user_roles` + `has_role()` pattern

Confirm and I'll implement Milestone 1.