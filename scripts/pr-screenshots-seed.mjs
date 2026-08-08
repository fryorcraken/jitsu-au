#!/usr/bin/env bun
//
// Fill a freshly started LOCAL Supabase stack with enough of a club to
// photograph every signed-in screen.
//
//   supabase start                 # Postgres + Auth + PostgREST + Storage
//   eval "$(supabase status -o env)"
//   SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
//     bun scripts/pr-screenshots-seed.mjs
//
// This NEVER runs against the hosted project. It refuses any URL that is not
// loopback (see assertLocal) — every insert below is a service-role write that
// bypasses RLS, so pointing it at production would write fixture members into
// the real club.
//
// What it writes is a small but complete club: a manager, a member with an
// approved waiver and a paid membership, and an applicant waiting on approval,
// plus the rows the manager screens list (waivers, memberships, bank
// transactions, contact messages, leads, blog posts and comments, knowledge
// base articles, calendar events, notifications). Screens whose table is left
// empty still photograph fine — they render their empty state, which is worth
// seeing too.
//
// The ids it created land in a manifest (PR_SCREENSHOTS_FIXTURE) that
// pr-screenshots.mjs reads: it needs the personas' email addresses to sign in,
// and the record ids to fill the `$userId` / `$id` / `$slug` route parameters.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { CODE_OF_CONDUCT_VERSION } from "../src/lib/code-of-conduct.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  process.env.PR_SCREENSHOTS_FIXTURE ?? ".screenshot-fixture.json",
);

/**
 * The password the personas get. Nothing signs in with it during the run (the
 * screenshot script uses an admin-generated magic link), but it is what makes
 * the seeded stack usable by hand: `supabase start`, seed, then sign in as
 * member@example.com to poke at a member screen locally.
 */
const PERSONA_PASSWORD = "screenshot-fixture-password";

/** RFC 2606 reserves example.com, so no fixture address can ever reach anyone. */
const PERSONAS = {
  manager: { email: "manager@example.com", firstName: "Priya", lastName: "Raman" },
  member: { email: "member@example.com", firstName: "Tom", lastName: "Okafor" },
  applicant: { email: "applicant@example.com", firstName: "Wei", lastName: "Zhang" },
};

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "[seed] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (see `supabase status -o env`).",
  );
  process.exit(1);
}
assertLocal(SUPABASE_URL);

/**
 * Refuse to seed anything but a local stack.
 *
 * Every write below runs as the service role, so this is the only thing
 * standing between a mistyped environment variable and fixture members in the
 * club's real database.
 */
function assertLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.error(`[seed] refusing to seed ${host}: this only ever runs against a local stack.`);
    process.exit(1);
  }
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Fixed ids, so the rows below can reference each other without a round trip. */
function id(n) {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

const PLAN = { trial: id(11), casual: id(12), term: id(13), insurance: id(14) };
const BLOG = { welcome: id(21), grading: id(22), draft: id(23) };
const KB_SECTION = { start: id(31), training: id(32) };
const KB_ARTICLE = { welcome: id(41), etiquette: id(42), firstClass: id(43) };
const SERIES = id(51);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** ISO instant `days` from now (negative = in the past), at `hour` UTC. */
function at(days, hour = 9) {
  const date = new Date(NOW + days * DAY);
  date.setUTCHours(hour, 30, 0, 0);
  return date.toISOString();
}
/** Just the date part, for `date` columns. */
function on(days) {
  return at(days).slice(0, 10);
}

/** Insert rows, failing loudly: a half-seeded database is worse than no run. */
async function insert(table, rows) {
  const { error } = await admin.from(table).insert(rows);
  if (error) throw new Error(`insert into ${table} failed: ${error.message}`);
  console.log(`[seed] ${table}: ${Array.isArray(rows) ? rows.length : 1}`);
}

/** Same, for a table something else has already put a row in (see profiles). */
async function upsert(table, rows, onConflict) {
  const { error } = await admin.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
  console.log(`[seed] ${table}: ${Array.isArray(rows) ? rows.length : 1}`);
}

/** Create a confirmed auth user and return its id. */
async function createUser(persona) {
  const { data, error } = await admin.auth.admin.createUser({
    email: persona.email,
    password: PERSONA_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`creating ${persona.email} failed: ${error.message}`);
  return data.user.id;
}

const users = {
  manager: await createUser(PERSONAS.manager),
  member: await createUser(PERSONAS.member),
  applicant: await createUser(PERSONAS.applicant),
};
console.log("[seed] auth users: 3");

// `ensure_profile` (a trigger on auth.users) has already made a bare row for
// each persona, so these fill it in rather than creating it.
await upsert(
  "profiles",
  [
    {
      user_id: users.manager,
      first_name: PERSONAS.manager.firstName,
      last_name: PERSONAS.manager.lastName,
      phone: "0400 000 001",
      address: "1 Broadway, Ultimo NSW 2007",
      date_of_birth: "1988-03-14",
      emergency_contact_name: "Anil Raman",
      emergency_contact_relationship: "Partner",
      emergency_contact_phone: "0400 000 011",
    },
    {
      user_id: users.member,
      first_name: PERSONAS.member.firstName,
      last_name: PERSONAS.member.lastName,
      preferred_name: "Tommy",
      phone: "0400 000 002",
      address: "42 Harris Street, Pyrmont NSW 2009",
      date_of_birth: "1999-11-02",
      uts_student_number: "12345678",
      gi_size: "3",
      belt_size: "3",
      martial_arts_experience: "Two years of judo at school, nothing since.",
      emergency_contact_name: "Ada Okafor",
      emergency_contact_relationship: "Sister",
      emergency_contact_phone: "0400 000 012",
      media_consent: true,
      sms_whatsapp_consent: true,
    },
    {
      user_id: users.applicant,
      first_name: PERSONAS.applicant.firstName,
      last_name: PERSONAS.applicant.lastName,
      phone: "0400 000 003",
      address: "9 Quay Street, Haymarket NSW 2000",
      date_of_birth: "2001-06-21",
      emergency_contact_name: "Lin Zhang",
      emergency_contact_relationship: "Parent",
      emergency_contact_phone: "0400 000 013",
    },
  ],
  "user_id",
);

await insert("user_roles", [
  { user_id: users.manager, role: "manager" },
  { user_id: users.member, role: "member" },
]);

await insert("waiver_templates", {
  version: 1,
  is_current: true,
  title: "Training waiver",
  body_md: [
    "# Training waiver",
    "",
    "{{adult_checkbox}} Adult (18+)",
    "{{minor_checkbox}} Under 18",
    "",
    "I, **{{full_name}}**, born {{date_of_birth}}, of {{address}}, agree to train with",
    "{{club_name}} on the terms below.",
    "",
    "Jiu jitsu is a contact sport. Injuries happen, and I take part knowing that.",
    "I will follow the instructions of the instructor on the mat at all times, and I",
    "will tell them about any injury or condition that affects my training.",
    "",
    "## Emergency contact",
    "",
    "{{emergency_contact_name}} ({{emergency_contact_relationship}}), {{emergency_contact_phone}}",
    "",
    "## Health",
    "",
    "{{medical_notes}}",
    "",
    "Signed by {{signature_name}} on {{signed_date}}.",
  ].join("\n"),
  acknowledgements: [
    { id: "risk", label: "I understand that jiu jitsu carries a risk of injury.", required: true },
    { id: "rules", label: "I will follow the instructor's directions on the mat.", required: true },
    {
      id: "media",
      label: "The club may use photos of me from training in its own posts.",
      required: false,
    },
  ],
});

const waivers = {
  member: id(61),
  applicant: id(62),
};

await insert("waivers", [
  {
    id: waivers.member,
    user_id: users.member,
    first_name: PERSONAS.member.firstName,
    last_name: PERSONAS.member.lastName,
    preferred_name: "Tommy",
    email: PERSONAS.member.email,
    phone: "0400 000 002",
    address: "42 Harris Street, Pyrmont NSW 2009",
    date_of_birth: "1999-11-02",
    uts_student_number: "12345678",
    emergency_contact_name: "Ada Okafor",
    emergency_contact_relationship: "Sister",
    emergency_contact_phone: "0400 000 012",
    medical_notes: "Old left knee sprain, fine to train.",
    media_consent: true,
    sms_whatsapp_consent: true,
    template_version: 1,
    approval_status: "approved",
    approved_at: at(-58),
    approved_by: users.manager,
    signed_at: at(-60),
    signer_ip: "203.0.113.7",
    pdf_path: `${waivers.member}.pdf`,
  },
  {
    id: waivers.applicant,
    user_id: users.applicant,
    first_name: PERSONAS.applicant.firstName,
    last_name: PERSONAS.applicant.lastName,
    email: PERSONAS.applicant.email,
    phone: "0400 000 003",
    address: "9 Quay Street, Haymarket NSW 2000",
    date_of_birth: "2001-06-21",
    emergency_contact_name: "Lin Zhang",
    emergency_contact_relationship: "Parent",
    emergency_contact_phone: "0400 000 013",
    template_version: 1,
    approval_status: "pending",
    signed_at: at(-2),
    signer_ip: "203.0.113.9",
    pdf_path: `${waivers.applicant}.pdf`,
  },
]);

// A stand-in for the generated document. The account page and the manager's
// waiver list both offer a download, and a signed URL for an object that does
// not exist is a broken link in a screenshot.
const PLACEHOLDER_PDF = new Blob(
  [
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF\n",
  ],
  { type: "application/pdf" },
);
for (const waiverId of Object.values(waivers)) {
  const { error } = await admin.storage
    .from("waivers")
    .upload(`${waiverId}.pdf`, PLACEHOLDER_PDF, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`uploading ${waiverId}.pdf failed: ${error.message}`);
}
console.log("[seed] waiver PDFs: 2");

await insert("code_of_conduct_acceptances", {
  user_id: users.member,
  email: PERSONAS.member.email,
  full_name: `${PERSONAS.member.firstName} ${PERSONAS.member.lastName}`,
  signature_name: `${PERSONAS.member.firstName} ${PERSONAS.member.lastName}`,
  version: CODE_OF_CONDUCT_VERSION,
  accepted_at: at(-59),
});

await insert("membership_plans", [
  {
    id: PLAN.trial,
    code: "trial",
    kind: "trial",
    name: "Free trial class",
    description: "Your first class, on us. No gi needed, just clothes you can move in.",
    public_price_cents: 0,
    student_price_cents: 0,
    session_credits: 1,
    sort_order: 1,
  },
  {
    id: PLAN.casual,
    code: "casual",
    kind: "session",
    name: "Casual class",
    description: "One class, paid on the day.",
    public_price_cents: 2500,
    student_price_cents: 1500,
    session_credits: 1,
    sort_order: 2,
  },
  {
    id: PLAN.term,
    code: "semester",
    kind: "period",
    name: "Semester membership",
    description: "Train as often as you like for the whole semester.",
    public_price_cents: 22000,
    student_price_cents: 16000,
    duration_days: 180,
    sort_order: 3,
  },
  {
    id: PLAN.insurance,
    code: "insurance",
    kind: "insurance",
    name: "Annual insurance",
    description: "Required once a year by the association.",
    public_price_cents: 6500,
    student_price_cents: 6500,
    duration_days: 365,
    sort_order: 4,
  },
]);

await insert("memberships", [
  {
    user_id: users.member,
    plan_id: PLAN.term,
    status: "active",
    is_student: true,
    price_cents: 16000,
    payment_method: "bank_transfer",
    payment_reference: "JITSU-000101",
    paid_at: at(-58),
    starts_at: at(-58),
    ends_at: at(122),
    uts_student_number: "12345678",
  },
  {
    user_id: users.member,
    plan_id: PLAN.insurance,
    status: "active",
    price_cents: 6500,
    payment_method: "bank_transfer",
    payment_reference: "JITSU-000102",
    paid_at: at(-58),
    starts_at: at(-58),
    ends_at: at(307),
  },
  {
    user_id: users.applicant,
    plan_id: PLAN.trial,
    status: "pending",
    price_cents: 0,
    payment_method: "manual",
    payment_reference: "JITSU-000103",
    session_date: on(3),
    sessions_remaining: 1,
  },
]);

await insert("bank_transactions", [
  {
    import_batch: "2026-08-01-westpac",
    dedupe_hash: "seed-transaction-1",
    amount_cents: 16000,
    description: "OSKO PAYMENT T OKAFOR",
    reference: "JITSU-000101",
    posted_at: at(-58),
    status: "matched",
  },
  {
    import_batch: "2026-08-01-westpac",
    dedupe_hash: "seed-transaction-2",
    amount_cents: 6500,
    description: "OSKO PAYMENT W ZHANG",
    reference: "JITSU 000199",
    posted_at: at(-4),
    status: "unmatched",
  },
  {
    import_batch: "2026-08-01-westpac",
    dedupe_hash: "seed-transaction-3",
    amount_cents: 2500,
    description: "TRANSFER FROM SAVINGS",
    reference: null,
    posted_at: at(-3),
    status: "unmatched",
  },
]);

await insert("calendar_series", {
  id: SERIES,
  title: "Tuesday class",
  description: "Our main weekly class. Beginners welcome, gi provided.",
  weekday: 2,
  start_time: "18:30",
  duration_minutes: 90,
  starts_on: on(-120),
  location: "UTS Ultimo, Building 4, Level 2",
  instructor_name: "Priya Raman",
  visibility: "public",
  is_active: true,
});

await insert(
  "calendar_events",
  [-14, -7, 1, 8, 15].map((days) => ({
    series_id: SERIES,
    title: "Tuesday class",
    description: "Our main weekly class. Beginners welcome, gi provided.",
    starts_at: at(days, 8),
    ends_at: at(days, 10),
    location: "UTS Ultimo, Building 4, Level 2",
    instructor_name: "Priya Raman",
    visibility: "public",
    status: "scheduled",
    created_by: users.manager,
  })),
);

await insert("blog_posts", [
  {
    id: BLOG.welcome,
    slug: "welcome-to-semester-two",
    title: "Welcome to semester two",
    excerpt: "New term, new mats, and a beginners' block starting in week one.",
    body_md: [
      "Semester two starts next week and we are back on the mats at Ultimo every",
      "Tuesday evening.",
      "",
      "If you have never trained before, week one is the week to come. We run the",
      "first twenty minutes as a beginners' block, so you will not be thrown into",
      "the deep end.",
      "",
      "Bring clothes you can move in. We have spare gis in most sizes.",
    ].join("\n"),
    status: "published",
    published_at: at(-9),
    author_id: users.manager,
  },
  {
    id: BLOG.grading,
    slug: "grading-night-results",
    title: "Grading night results",
    excerpt: "Nine gradings, one new brown belt, and a lot of very tired people.",
    body_md: [
      "Grading night went late and everyone who stepped up passed.",
      "",
      "Thank you to everyone who came down to watch. The next grading will be",
      "toward the end of the semester.",
    ].join("\n"),
    status: "published",
    published_at: at(-30),
    author_id: users.manager,
  },
  {
    id: BLOG.draft,
    slug: "summer-training-plan",
    title: "Summer training plan",
    excerpt: "What the club is doing over the break.",
    body_md: "Still working out the dates for the summer sessions.",
    status: "draft",
    author_id: users.manager,
  },
]);

await insert("blog_comments", [
  {
    post_id: BLOG.welcome,
    user_id: users.member,
    body: "Is the beginners' block on every week or just week one?",
    status: "visible",
    created_at: at(-8),
  },
  {
    post_id: BLOG.welcome,
    user_id: users.manager,
    body: "Just week one, but come along any week and we will look after you.",
    status: "visible",
    created_at: at(-8),
  },
  {
    post_id: BLOG.grading,
    user_id: users.member,
    body: "Congratulations everyone!",
    status: "hidden",
    hidden_at: at(-29),
    hidden_by: users.manager,
    hidden_reason: "Duplicate",
    created_at: at(-29),
  },
]);

await insert("kb_sections", [
  { id: KB_SECTION.start, slug: "start-here", title: "Start here", position: 1 },
  { id: KB_SECTION.training, slug: "training", title: "Training", position: 2 },
]);

await insert("kb_articles", [
  {
    id: KB_ARTICLE.welcome,
    slug: "welcome",
    section_id: KB_SECTION.start,
    position: 1,
    visibility: "members",
    annotations_enabled: true,
    created_by: users.manager,
  },
  {
    id: KB_ARTICLE.firstClass,
    slug: "your-first-class",
    section_id: KB_SECTION.start,
    position: 2,
    visibility: "members",
    link_path: "/first-class",
    nav_title: "Your first class",
    created_by: users.manager,
  },
  {
    id: KB_ARTICLE.etiquette,
    slug: "mat-etiquette",
    section_id: KB_SECTION.training,
    position: 1,
    visibility: "members",
    annotations_enabled: true,
    created_by: users.manager,
  },
]);

await insert("kb_article_versions", [
  {
    article_id: KB_ARTICLE.welcome,
    version: 1,
    is_current: true,
    title: "Welcome to the club",
    body_md: [
      "This is the reading we give everyone who trains with us. Work through it in",
      "order and you will know everything you need for your first few months.",
      "",
      "## What we train",
      "",
      "Japanese jiu jitsu: throws, groundwork, joint locks and strikes, practised",
      "with a partner rather than against one.",
      "",
      "## When we train",
      "",
      "Tuesday evenings at UTS Ultimo during semester. Check the calendar for the",
      "current dates.",
    ].join("\n"),
    created_by: users.manager,
  },
  {
    article_id: KB_ARTICLE.etiquette,
    version: 1,
    is_current: true,
    title: "Mat etiquette",
    body_md: [
      "A few habits keep training safe and quick to run.",
      "",
      "- Bow on and off the mat.",
      "- Nails short, jewellery off, gi clean.",
      "- Tap early. Tapping is information, not defeat.",
      "- Tell your partner about any injury before you start.",
    ].join("\n"),
    created_by: users.manager,
  },
]);

await insert("kb_annotations", {
  article_id: KB_ARTICLE.etiquette,
  article_version: 1,
  user_id: users.member,
  body: "Does this mean I should take my wedding ring off, or is taping it enough?",
  quote: "Nails short, jewellery off, gi clean.",
  visibility: "shared",
  created_at: at(-5),
});

await insert("notification_preferences", {
  user_id: users.member,
  new_blog_post: true,
  reply_to_me: true,
  thread_activity: false,
});

await insert("notifications", [
  {
    user_id: users.member,
    kind: "new_blog_post",
    subject_type: "blog_post",
    subject_id: BLOG.welcome,
    title: "New post: Welcome to semester two",
    body: "New term, new mats, and a beginners' block starting in week one.",
    href: "/blog/welcome-to-semester-two",
    created_at: at(-9),
  },
  {
    user_id: users.member,
    kind: "reply",
    subject_type: "blog_comment",
    subject_id: BLOG.welcome,
    actor_id: users.manager,
    title: "Priya replied to your comment",
    body: "Just week one, but come along any week and we will look after you.",
    href: "/blog/welcome-to-semester-two",
    created_at: at(-8),
    read_at: at(-7),
  },
  {
    user_id: users.manager,
    kind: "kb_comment",
    subject_type: "kb_annotation",
    subject_id: KB_ARTICLE.etiquette,
    actor_id: users.member,
    title: "Tom commented on Mat etiquette",
    body: "Does this mean I should take my wedding ring off, or is taping it enough?",
    href: "/kb/mat-etiquette",
    created_at: at(-5),
  },
]);

await insert("contact_messages", [
  {
    name: "Jamie Cole",
    email: "jamie.cole@example.com",
    subject: "Trying a class",
    message: "Hi, I am a UTS student and would like to try a class next week. Do I need a gi?",
    created_at: at(-2),
  },
  {
    name: "Sofia Marin",
    email: "sofia.marin@example.com",
    subject: "Membership question",
    message: "Can I pause my membership over the summer break?",
    created_at: at(-11),
  },
]);

await insert("interest_registrations", [
  {
    name: "Alex Whitfield",
    email: "alex.whitfield@example.com",
    phone: "0400 000 021",
    uts_student: true,
    experience: "None at all, complete beginner.",
    message: "Are the Tuesday classes beginner friendly?",
    created_at: at(-1),
  },
  {
    name: "Nadia Haddad",
    email: "nadia.haddad@example.com",
    phone: "0400 000 022",
    uts_student: false,
    experience: "Four years of BJJ, blue belt.",
    created_at: at(-6),
  },
]);

const fixture = {
  // What signing in needs.
  personas: {
    manager: { email: PERSONAS.manager.email, userId: users.manager },
    member: { email: PERSONAS.member.email, userId: users.member },
  },
  password: PERSONA_PASSWORD,
  // What the `$param` segments of the dynamic routes need, keyed by the
  // parameter's own name (see fillRouteParams in pr-screenshots-pages.mjs).
  params: {
    userId: users.member,
    id: BLOG.welcome,
    slug: "welcome",
  },
};

writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`[seed] wrote ${FIXTURE_PATH}`);
