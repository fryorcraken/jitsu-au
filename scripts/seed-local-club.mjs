#!/usr/bin/env bun
//
// Fill a freshly started LOCAL Supabase stack with enough of a club to sign in
// to and use.
//
// The end-to-end suite runs against what this writes (e2e/, docs/e2e-tests.md):
// it walks the flows on these people and photographs them on the way, which is
// where a pull request's screenshots come from. It is named after the club
// rather than after the suite because the club is the thing being described.
//
//   supabase start                 # Postgres + Auth + PostgREST + Storage
//   eval "$(supabase status -o env)"
//   SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
//     bun scripts/seed-local-club.mjs
//
// This NEVER runs against the hosted project. It refuses any URL that is not
// loopback (see assertLocal) — every insert below is a service-role write that
// bypasses RLS, so pointing it at production would write fixture members into
// the real club.
//
// What it writes is the PEOPLE and the ACTIVITY: a manager, a member with an
// approved waiver and a paid membership, an applicant waiting on approval, plus
// the rows the manager screens list (waivers, memberships, bank transactions,
// contact messages, leads, blog posts and comments, knowledge base articles,
// calendar events, notifications). The club's own starting content — the
// waiver template, the membership plans, the knowledge base sections — is
// already in the database because the migrations put it there, so this reads
// those rows rather than inserting rival copies. Screens whose table is left
// empty still photograph fine: they render their empty state, which is worth
// seeing too.
//
// The ids it created land in a manifest (LOCAL_CLUB_FIXTURE) that its readers
// need: the personas' email addresses to sign in as, and the record ids that
// fill the `$userId` / `$id` / `$slug` route parameters.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { CODE_OF_CONDUCT_VERSION } from "../src/lib/code-of-conduct.ts";
import { splitBlocks } from "../src/lib/kb.ts";
import { isLocalSupabase } from "./local-supabase.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  process.env.LOCAL_CLUB_FIXTURE ?? ".local-club-fixture.json",
);

/**
 * The password the personas get. Nothing signs in with it during the run (the
 * screenshot script uses an admin-generated magic link), but it is what makes
 * the seeded stack usable by hand: `supabase start`, seed, then sign in as
 * member@example.com to poke at a member screen locally.
 */
const PERSONA_PASSWORD = "local-club-fixture-password";

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
  if (isLocalSupabase(url)) return;
  const host = new URL(url).hostname;
  console.error(`[seed] refusing to seed ${host}: this only ever runs against a local stack.`);
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Fixed ids, so the rows below can reference each other without a round trip. */
function id(n) {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

const BLOG = { welcome: id(21), grading: id(22), draft: id(23) };
const KB_ARTICLE = { welcome: id(41), etiquette: id(42) };
const SERIES = id(51);
const IMPORT_BATCH = id(71);

/** Named so the annotation below can be anchored to one of its blocks. */
const ETIQUETTE_BODY = [
  "A few habits keep training safe and quick to run.",
  "",
  "- Bow on and off the mat.",
  "- Nails short, jewellery off, gi clean.",
  "- Tap early. Tapping is information, not defeat.",
  "- Tell your partner about any injury before you start.",
].join("\n");

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

/**
 * Everything that went wrong, so one run can report all of it.
 *
 * The stack this seeds can only be started where the Supabase container images
 * are reachable, which in practice means CI. Stopping at the first bad column
 * would then cost a whole pipeline run per mistake, so the writes below keep
 * going and the script fails at the end with the full list. Rows whose parent
 * failed will fail too — that noise sits next to its own cause and is worth
 * having.
 *
 * Deliberately NOT collected: creating the people (`createUser`) and reading
 * what the migrations shipped (`select`, `planOf`). Every row below hangs off
 * those, so carrying on past one would report a page of failures that all say
 * the same thing. They throw, and the stack trace is the message.
 */
const failures = [];

/** Run one write, recording a failure instead of stopping the run. */
async function attempt(label, run) {
  try {
    await run();
    return true;
  } catch (error) {
    const message = error?.message ?? String(error);
    failures.push(`${label}: ${message}`);
    console.error(`[seed] FAILED ${label}: ${message}`);
    return false;
  }
}

/**
 * Insert rows.
 *
 * `defaultToNull: false` is what makes a batch behave the way each row reads.
 * PostgREST turns a batch into ONE insert over the union of every row's keys,
 * and by default a key a row does not mention is sent as an explicit NULL —
 * so a column only some rows set (`sms_whatsapp_consent`, `media_consent`)
 * blows up on its NOT NULL instead of taking the column default.
 */
async function insert(table, rows) {
  await attempt(`insert into ${table}`, async () => {
    const { error } = await admin.from(table).insert(rows, { defaultToNull: false });
    if (error) throw new Error(error.message);
    console.log(`[seed] ${table}: ${Array.isArray(rows) ? rows.length : 1}`);
  });
}

/** Read rows, failing loudly. */
async function select(table, columns, build = (query) => query) {
  const { data, error } = await build(admin.from(table).select(columns));
  if (error) throw new Error(`reading ${table} failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fill in the profile row that already exists for `userId`.
 *
 * `ensure_profile` (a trigger on auth.users) makes a bare row the moment a
 * person is created, so these are updates, not inserts. An upsert of all three
 * at once does not work: PostgREST turns a batch into ONE insert over the union
 * of every row's keys, so a column that only some rows mention arrives as an
 * explicit NULL and trips the NOT NULLs (`sms_whatsapp_consent`).
 */
async function fillProfile(userId, values) {
  await attempt(`filling in profile ${userId}`, async () => {
    // `.select()` so a match of NO rows is caught. An update that hits nothing
    // returns no error, and this is the seed's only write that depends on a
    // trigger having run rather than on something it did itself — drop
    // `ensure_profile` and every signed-in screenshot would quietly show
    // "Member" with blank contact details behind a green run.
    const { data, error } = await admin
      .from("profiles")
      .update(values)
      .eq("user_id", userId)
      .select("user_id");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error("no profile row to fill in — did the ensure_profile trigger run?");
    }
  });
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

await fillProfile(users.manager, {
  first_name: PERSONAS.manager.firstName,
  last_name: PERSONAS.manager.lastName,
  phone: "0400 000 001",
  address: "1 Broadway, Ultimo NSW 2007",
  date_of_birth: "1988-03-14",
  emergency_contact_name: "Anil Raman",
  emergency_contact_relationship: "Partner",
  emergency_contact_phone: "0400 000 011",
});
await fillProfile(users.member, {
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
});
await fillProfile(users.applicant, {
  first_name: PERSONAS.applicant.firstName,
  last_name: PERSONAS.applicant.lastName,
  phone: "0400 000 003",
  address: "9 Quay Street, Haymarket NSW 2000",
  date_of_birth: "2001-06-21",
  emergency_contact_name: "Lin Zhang",
  emergency_contact_relationship: "Parent",
  emergency_contact_phone: "0400 000 013",
});
console.log("[seed] profiles: 3");

await insert("user_roles", [
  { user_id: users.manager, role: "manager" },
  { user_id: users.member, role: "member" },
]);

// ---------------------------------------------------------------------------
// The migrations already ship the club's own starting content: the current
// waiver template, the four membership plans, and the knowledge base sections.
// This fixture adds PEOPLE and ACTIVITY on top of that rather than a second
// copy of it, so it reads those rows instead of inserting rival ones — which is
// also why it does not go stale when a migration changes them.
// ---------------------------------------------------------------------------

const [currentTemplate] = await select("waiver_templates", "version", (query) =>
  query.eq("is_current", true).limit(1),
);
if (!currentTemplate) throw new Error("no current waiver template: check the migrations");
const TEMPLATE_VERSION = currentTemplate.version;

const plans = await select(
  "membership_plans",
  "id, kind, name, public_price_cents, student_price_cents",
);
/**
 * The plan of a given kind a manager would reach for, creating one when the
 * schema ships none.
 *
 * `trial`, `session` and `insurance` plans arrive with the migrations. A
 * `period` plan does not, and that is not an oversight: semesters used to live
 * in `club_semesters`, that table is gone (20260804010000), and each semester
 * is now a dated plan a manager creates for themselves. So a database with
 * nothing but migrations in it has nobody who *can* hold a membership until
 * this makes the semester a manager would have made.
 */
async function planOf(kind, fallback) {
  const existing = plans.find((candidate) => candidate.kind === kind);
  if (existing) return existing;
  if (!fallback) {
    throw new Error(`no ${kind} membership plan to put anyone on: check the migrations`);
  }
  const { data, error } = await admin
    .from("membership_plans")
    .insert(fallback)
    .select("id, kind, name, public_price_cents, student_price_cents")
    .single();
  if (error) throw new Error(`creating a ${kind} plan failed: ${error.message}`);
  console.log(`[seed] membership_plans: 1 (${kind})`);
  return data;
}

const PERIOD_PLAN = await planOf("period", {
  code: "screenshot-semester",
  name: "This semester",
  description: "Unlimited classes for the whole semester. Grading fee included.",
  kind: "period",
  public_price_cents: 44500,
  student_price_cents: 24500,
  starts_on: on(-60),
  ends_on: on(120),
  sort_order: 2,
});
const INSURANCE_PLAN = await planOf("insurance");
const TRIAL_PLAN = await planOf("trial");
/** What this person actually paid, so the invoice on screen adds up. */
function priceOf(plan, isStudent) {
  return isStudent
    ? (plan.student_price_cents ?? plan.public_price_cents)
    : plan.public_price_cents;
}

const sections = await select("kb_sections", "id, slug, title", (query) =>
  query.order("position", { ascending: true }),
);
if (sections.length === 0) throw new Error("no knowledge base sections: check the migrations");

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
    template_version: TEMPLATE_VERSION,
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
    template_version: TEMPLATE_VERSION,
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
  await attempt(`uploading ${waiverId}.pdf`, async () => {
    const { error } = await admin.storage
      .from("waivers")
      .upload(`${waiverId}.pdf`, PLACEHOLDER_PDF, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(error.message);
  });
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

await insert("memberships", [
  {
    user_id: users.member,
    plan_id: PERIOD_PLAN.id,
    status: "active",
    is_student: true,
    price_cents: priceOf(PERIOD_PLAN, true),
    payment_method: "bank_transfer",
    payment_reference: "JITSU-000101",
    paid_at: at(-58),
    starts_at: at(-58),
    ends_at: at(122),
    uts_student_number: "12345678",
  },
  {
    user_id: users.member,
    plan_id: INSURANCE_PLAN.id,
    status: "active",
    price_cents: priceOf(INSURANCE_PLAN, false),
    payment_method: "bank_transfer",
    payment_reference: "JITSU-000102",
    paid_at: at(-58),
    starts_at: at(-58),
    ends_at: at(307),
  },
  {
    user_id: users.applicant,
    plan_id: TRIAL_PLAN.id,
    status: "pending",
    price_cents: priceOf(TRIAL_PLAN, false),
    payment_method: "manual",
    payment_reference: "JITSU-000103",
    session_date: on(3),
    sessions_remaining: 1,
  },
]);

await insert("bank_transactions", [
  {
    import_batch: IMPORT_BATCH,
    dedupe_hash: "seed-transaction-1",
    amount_cents: 16000,
    description: "OSKO PAYMENT T OKAFOR",
    reference: "JITSU-000101",
    posted_at: at(-58),
    status: "matched",
  },
  {
    import_batch: IMPORT_BATCH,
    dedupe_hash: "seed-transaction-2",
    amount_cents: 6500,
    description: "OSKO PAYMENT W ZHANG",
    reference: "JITSU 000199",
    posted_at: at(-4),
    status: "unmatched",
  },
  {
    import_batch: IMPORT_BATCH,
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

// The migrations create the sections and the two link entries; these are the
// first two articles with words in them, one per section so the sidebar shows
// the shape of a reading path rather than a single list.
await insert("kb_articles", [
  {
    id: KB_ARTICLE.welcome,
    slug: "welcome",
    section_id: sections[0].id,
    position: 5,
    visibility: "members",
    annotations_enabled: true,
    created_by: users.manager,
  },
  {
    id: KB_ARTICLE.etiquette,
    slug: "mat-etiquette",
    section_id: (sections[1] ?? sections[0]).id,
    position: 15,
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
    body_md: ETIQUETTE_BODY,
    created_by: users.manager,
  },
]);

// Anchored to the passage it is about, exactly as the reader anchors one: a
// hash of that block's own text (see `blockId` in src/lib/kb.ts). Left null it
// would still be a valid row, but `resolveAnchors` would file it as an
// article-level note and the passage-anchored comment UI — the thing worth
// looking at in a screenshot — would never be on screen.
const etiquetteAnchor = splitBlocks(ETIQUETTE_BODY).find((block) =>
  block.markdown.includes("jewellery off"),
);
if (!etiquetteAnchor) {
  failures.push("no block in the mat etiquette article to anchor the annotation to");
}
await insert("kb_annotations", {
  article_id: KB_ARTICLE.etiquette,
  article_version: 1,
  user_id: users.member,
  body: "Does this mean I should take my wedding ring off, or is taping it enough?",
  quote: "Nails short, jewellery off, gi clean.",
  block_id: etiquetteAnchor?.id ?? null,
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
  // Which database these ids exist in. e2e/support/fixture.ts refuses to sign in
  // when this does not match its own SUPABASE_URL: the manifest and the
  // credentials arriving from different places is the failure that would put
  // fixture people in the club's real auth.
  supabaseUrl: SUPABASE_URL,
  // What signing in needs.
  personas: {
    manager: { email: PERSONAS.manager.email, userId: users.manager },
    member: { email: PERSONAS.member.email, userId: users.member },
  },
  password: PERSONA_PASSWORD,
  // What the `$param` segments of the dynamic routes need, keyed by the
  // parameter's own name (see fillRouteParams in scripts/site-pages.ts).
  params: {
    userId: users.member,
    id: BLOG.welcome,
    slug: "welcome",
  },
};

if (failures.length > 0) {
  console.error(`\n[seed] ${failures.length} write(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`[seed] wrote ${FIXTURE_PATH}`);
