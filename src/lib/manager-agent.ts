// Pure, server-import-free logic for the manager agent HTTP API.
//
// The endpoint (src/routes/api/manager/agent.ts) is the only place that touches
// the database; everything that can be unit-tested without a request/DB context
// lives here: the self-describing manifest, bearer-token handling, the
// invoice-edit patch builder, and the response projections.
//
// Keep AGENT_MANIFEST, managerAgentActions (validation.ts), the route dispatch,
// and the skill (.claude/skills/uts-manager-agent/) in lockstep. See docs/manager-agent-api.md.
import { formatCents, isPaperWaiver, sameInstant } from "@/lib/validation";
import type { AgentSaveBlogPostInput, BlogPostInput, EditInvoiceInput } from "@/lib/validation";
import type { MembershipPlanRow, MembershipRow } from "@/lib/membership-types";
import { versionLabel } from "@/lib/document-versions";
import { canonicalUrl } from "@/lib/seo";
import { SITE_ORIGIN } from "@/lib/site-origin";
import { WEEKDAY_LABELS, clubLocalDateTime } from "@/lib/calendar";

/** The columns `list_kb_articles` projects from. */
export type AgentKbArticle = {
  slug: string;
  nav_title: string | null;
  link_path: string | null;
  section_id: string | null;
  position: number;
  visibility: string;
  annotations_enabled: boolean;
  updated_at: string;
};

/** The live version of an article, when it has one. */
export type AgentKbVersion = {
  title: string;
  version: number;
  created_at: string;
  change_note: string | null;
};

/**
 * One row of `list_kb_articles`.
 *
 * `title` is always the LIVE VERSION's heading, never the sidebar label. That
 * distinction is the whole reason this is a function with a test: falling back
 * to `nav_title` makes an article's real heading unobtainable from the list, and
 * an agent that reads the list and builds a `save_kb_article` from what it read
 * would silently rename the heading to the sidebar label.
 *
 * A LINK ENTRY has no version, so there the label IS the title, and the null
 * `version` is what tells an agent it is looking at a signpost rather than a
 * page whose text it can edit.
 */
export function projectAgentKbArticle(
  article: AgentKbArticle,
  live: AgentKbVersion | undefined,
  sectionSlug: string | null,
  versions: number,
) {
  return {
    slug: article.slug,
    title: article.link_path ? article.nav_title : (live?.title ?? null),
    nav_title: article.nav_title,
    link_path: article.link_path,
    version: live?.version ?? null,
    versions,
    section: sectionSlug,
    position: article.position,
    visibility: article.visibility,
    annotations_enabled: article.annotations_enabled,
    url: article.link_path ?? `/kb/${article.slug}`,
    change_note: live?.change_note ?? null,
    updated_at: live?.created_at ?? article.updated_at,
  };
}

/**
 * One stored waiver version, as `list_waiver_templates` reports it.
 *
 * Deliberately structural rather than importing `WaiverTemplateVersion` from
 * `waiver.functions.ts`: this module is pure and server-import-free (see the
 * header), and that one pulls in `createServerFn` and a Supabase client.
 */
export type AgentWaiverTemplate = {
  version: number;
  title: string;
  body_md: string;
  acknowledgements: { id: string; label: string; required: boolean }[];
  is_current: boolean;
  created_at: string;
};

/**
 * A version as the LIST reports it: no body, and the same Live/Previous/Draft
 * label the editor screen shows.
 *
 * The body is left out because a club with a dozen versions of a 30000-character
 * legal document would otherwise send a third of a megabyte to answer "which one
 * is live" — `get_waiver_template` is one call away when the text is wanted.
 * `body_chars` stays so a caller can tell a real version from a stub without
 * fetching it.
 *
 * `status` reuses `versionLabel`, so an agent and a manager reading the same
 * version see the same word for it. "Draft" there means "never been live", not
 * "unpublished work in progress" — saving always publishes, so the only drafts
 * are versions seeded outside the editor and versions superseded by a rollback.
 */
export function projectAgentWaiverTemplate(
  template: AgentWaiverTemplate,
  liveVersion: number | null,
) {
  return {
    version: template.version,
    title: template.title,
    is_current: template.is_current,
    status: versionLabel(template, liveVersion),
    // Named for what it is, not `acknowledgements`: `get_waiver_template`
    // returns that name holding the actual list, and one field meaning a count
    // on one action and an array on another is how a caller ends up iterating a
    // number. Same reason `projectAgentKbArticle` calls its count `versions`.
    acknowledgement_count: template.acknowledgements.length,
    body_chars: template.body_md.length,
    created_at: template.created_at,
  };
}

/**
 * What the person page reads that `get_user` does NOT report, each with why.
 *
 * Everything else passes through. That is the point of the shape: `get_user`
 * is the person page's own read (`loadClubUser`), so a field added to that page
 * reaches the API in the same change without anybody remembering to project it,
 * and leaving one out has to be written down here, where a test checks the list
 * against the read.
 */
export const GET_USER_LEFT_OUT = {
  /** The read's own bookkeeping: the endpoint turns a non-empty list into a 500. */
  top: ["degraded"],
  /**
   * The signer's IP address and browser context, kept on a waiver as forensic
   * evidence. No agent workflow needs them, and an agent's transcript is a far
   * less careful place to keep somebody's IP address than the database.
   *
   * The one thing the page reads out of `signer_meta` is whether the waiver is
   * a scanned paper form, so that much is reported, as `is_paper`.
   */
  waiver: ["signer_ip", "signer_meta"],
} as const;

/**
 * `get_user`'s result: the person page's read, less what `GET_USER_LEFT_OUT`
 * names. Generic rather than typed against `loadClubUser`, because this module
 * is pure and server-import-free (see the header); the test pins it against the
 * real read.
 */
export function projectAgentUser<
  R extends Record<GetUserTopLeftOut, unknown> & {
    waivers: Record<GetUserWaiverLeftOut, unknown>[];
  },
>(
  read: R,
): Omit<R, GetUserTopLeftOut | "waivers"> & {
  waivers: AgentUserWaiver<R["waivers"][number]>[];
} {
  // Driven by the list rather than restating it, so a name added there is
  // withheld here: the list is the promise, and this is what keeps it.
  return {
    ...omit(read, GET_USER_LEFT_OUT.top),
    waivers: read.waivers.map((w) => ({
      ...omit(w, GET_USER_LEFT_OUT.waiver),
      // The person page's "Filing record" rather than "Signing record". An
      // agent filing paper waivers needs it to tell what is already on file.
      is_paper: isPaperWaiver(w.signer_meta),
    })),
  } as Omit<R, GetUserTopLeftOut | "waivers"> & {
    waivers: AgentUserWaiver<R["waivers"][number]>[];
  };
}

type AgentUserWaiver<W> = Omit<W, GetUserWaiverLeftOut> & { is_paper: boolean };

type GetUserTopLeftOut = (typeof GET_USER_LEFT_OUT.top)[number];
type GetUserWaiverLeftOut = (typeof GET_USER_LEFT_OUT.waiver)[number];

function omit<T extends object, K extends string>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value } as Record<string, unknown>;
  for (const k of keys) delete copy[k];
  return copy as Omit<T, K>;
}

/**
 * One stored code-of-conduct version as `list_code_of_conduct_versions` reports
 * it: no text (one call away on `get_code_of_conduct`, and not read at all for
 * the listing), the same Live/Previous/Draft word the editor screen shows, and
 * whether publishing it asked everybody to agree again. Structural, like
 * `AgentWaiverTemplate`, so this module stays server-import-free.
 *
 * The label uses `first_published_at`, so a version rolled away from still
 * reads "Previous" rather than "Draft".
 */
export function projectAgentCodeOfConductVersion(
  version: {
    version: number;
    title: string;
    asks_reagreement: boolean;
    required_version: number;
    is_current: boolean;
    first_published_at: string | null;
    created_at: string;
  },
  liveVersion: number | null,
) {
  return {
    version: version.version,
    title: version.title,
    is_current: version.is_current,
    status: versionLabel(version, liveVersion, version.first_published_at !== null),
    asks_reagreement: version.asks_reagreement,
    required_version: version.required_version,
    first_published_at: version.first_published_at,
    created_at: version.created_at,
  };
}

/** The `blog_posts` columns the blog actions project from. */
export type AgentBlogPost = {
  id: string;
  slug: string;
  title: string;
  status: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A post as the blog actions report it. Two addresses, because they answer
 * different questions: `url` is where the public reads it, and is null for a
 * draft, which has no public address (the public route 404s on one, so a link
 * to it handed to anybody is a dead link); `edit_url` is the manager's own
 * screen for it, which works whatever its status and is the link to give a
 * manager who wants to look before it goes live.
 */
export function projectAgentBlogPost(post: AgentBlogPost) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    status: post.status,
    published_at: post.published_at,
    created_at: post.created_at,
    updated_at: post.updated_at,
    url: post.status === "published" ? canonicalUrl(`/blog/${post.slug}`) : null,
    edit_url: `${SITE_ORIGIN}/manager/blog/${post.id}`,
  };
}

/** The stored post a `save_blog_post` change starts from. */
export type AgentBlogPostStored = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  cover_image_path: string | null;
  status: string;
};

/**
 * The whole post a `save_blog_post` change writes: what the agent sent, and
 * the stored value of everything it left out.
 *
 * This is the function the action's safety rests on. The post form always
 * sends every field, so the shared writer treats an absent `status` as draft
 * and an absent `cover_image_path` as none. Sent straight through, "fix the
 * typo in the second paragraph" would unpublish the post and drop its cover.
 */
export function mergeAgentBlogPostEdit(
  stored: AgentBlogPostStored,
  input: AgentSaveBlogPostInput,
): BlogPostInput & { id: string } {
  return {
    id: stored.id,
    title: input.title ?? stored.title,
    slug: input.slug ?? stored.slug,
    excerpt: input.excerpt ?? stored.excerpt ?? "",
    body_md: input.body_md ?? stored.body_md,
    cover_image_path: input.cover_image_path ?? stored.cover_image_path ?? "",
    status: input.status ?? (stored.status === "published" ? "published" : "draft"),
  };
}

/**
 * One date on the calendar, as the manager calendar's own read returns it
 * (`listManagerEventRows`, and the dates `createCalendarEntryRow` adds, which
 * carry no tally).
 */
export type AgentCalendarEvent = {
  id: string;
  series_id: string | null;
  title: string;
  description: string | null;
  instructor_name: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  visibility: string;
  invite_only: boolean;
  rsvps?: { going: number; maybe: number; declined: number };
};

/**
 * One date as `list_calendar_events` and `create_calendar_entry` report it: the
 * screen's row, plus what an agent would otherwise work out for itself and get
 * wrong.
 *
 * - `starts_local` / `ends_local` are club time, in the "YYYY-MM-DDTHH:MM" shape
 *   `create_calendar_entry` takes back. The manager thinks in Sydney time, the
 *   stored instants are UTC, and twice a year the offset between them moves.
 * - `weekday` is the club-time day the date starts on. "Cancel Thursday's
 *   class" is how a manager asks, and a language model asked which weekday a
 *   date falls on will sometimes answer wrong with complete confidence.
 * - `repeats` says whether `series_id` is set, which decides whether a "this and
 *   every later date" scope applies and whether the date can be deleted.
 */
export function projectAgentCalendarEvent(e: AgentCalendarEvent) {
  const startsLocal = clubLocalDateTime(new Date(e.starts_at));
  return {
    id: e.id,
    series_id: e.series_id,
    repeats: e.series_id !== null,
    title: e.title,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    starts_local: startsLocal,
    ends_local: clubLocalDateTime(new Date(e.ends_at)),
    weekday: WEEKDAY_LABELS[new Date(`${startsLocal.slice(0, 10)}T00:00:00Z`).getUTCDay()],
    status: e.status,
    visibility: e.visibility,
    invite_only: e.invite_only,
    instructor_name: e.instructor_name,
    location: e.location,
    description: e.description,
    ...(e.rsvps && { rsvps: e.rsvps }),
  };
}

/** One action's shape, returned verbatim by the GET manifest endpoint. */
export type AgentActionSpec = {
  name: string;
  method: "POST";
  summary: string;
  params: { name: string; required: boolean; description: string }[];
};

/**
 * The runtime source of truth for what the endpoint can do. An agent should GET
 * the endpoint to read this before acting, so a skill/MCP wrapper never drifts
 * from the deployed contract. When you add or change an action, update this,
 * the Zod schema in validation.ts, the route dispatch, and the skill.
 */
export const AGENT_MANIFEST: {
  service: string;
  version: string;
  changes: { version: string; breaking: boolean; notes: string[] }[];
  actions: AgentActionSpec[];
} = {
  service: "uts-jitsu-manager-agent",
  // Bumped when the behaviour a client can rely on changes, not just the action
  // list. See `changes` for what each version actually moved.
  version: "31",
  // What changed in each version, newest first.
  //
  // A bare version number tells a client THAT something moved, never what — and
  // the one client that most needs to know is the one that cached the manifest
  // at the start of a long bulk import and cannot re-read it mid-run. Diffing
  // whole manifest prose is not an answer.
  //
  // Deliberately a changelog and not a per-action `since` tag: every action here
  // existed in "1", so `since` would read "1" on all four and say nothing. What
  // moves between versions is the behaviour INSIDE an action — a new refusal, a
  // new response field — which is what these notes name.
  changes: [
    {
      version: "31",
      // New actions, and nothing that worked before changes.
      breaking: false,
      notes: [
        "The club calendar, the agent's equivalent of the manager's Calendar screen, through the same functions that screen calls. New read actions: list_calendar_events (every date from 30 days ago to 180 days ahead, with its id, series_id and repeats, UTC starts_at/ends_at, club-time starts_local/ends_local and weekday, status, visibility, invite_only and an rsvps tally) and list_calendar_rsvps (who replied to one date).",
        "New change actions: create_calendar_entry (a one-off, or a weekly entry), edit_calendar_entry (details only, for one date or that date and every later one), cancel_calendar_entry (cancel or restore, the date is kept), stop_calendar_repeat (take a weekly entry's dates still to come off the calendar) and delete_calendar_entry (a one-off made by mistake). Each date's id is what they take, except stop_calendar_repeat, which takes series_id. A calendar change is public at once, on the site and in every subscriber's calendar app, and emails nobody.",
        "create_calendar_entry takes a one-off's times as club time with no offset (2026-11-05T18:00), as the screen reads its pickers, or as an ISO time with an offset. A location left out is the club's gym, as the screen's form pre-fills. Adding the same entry again is 409 already_on_calendar rather than a second copy, so a create you never heard back from can be sent again.",
        "Refusals: 404 not_found (no such date or repeat), 422 not_repeating (scope series on a one-off), 422 no_dates (a weekly entry that would put no date on the calendar), 409 repeating_date (deleting one date of a weekly entry), 409 checked_in (deleting a class people were checked in to), 409 already_on_calendar. Details, where there are any, are in error.details.",
        "list_calendar_events takes no params, and refuses any (400 invalid_params) rather than return the whole list as if it had been filtered.",
      ],
    },
    {
      version: "30",
      // Two new optional params, and one param no longer required when the
      // new one replaces it. Every call that worked before still works.
      breaking: false,
      notes: [
        "file_waiver takes address_parts { street, suburb, state, postcode }: the participant's address in parts, as the online form now asks for it. state is one of ACT, NSW, NT, QLD, SA, TAS, VIC, WA and postcode is four digits. Send it instead of address; address (one line, as written) is still accepted when the paper's address cannot be split, and is stored as written with no parts. One of the two is required, and address_parts wins when both are sent, with the line composed from it as \"<street>, <suburb> <STATE> <postcode>\".",
        "file_waiver takes guardian_address_parts in the same shape, for a guardian who does not live at the participant's address. guardian_address (one line) is still accepted.",
        "An address outside Australia has no parts: send it as the one line in address (or guardian_address), in any format, as the site's own forms do.",
      ],
    },
    {
      version: "29",
      // Purely additive: two new actions. Nothing that worked before changes.
      breaking: false,
      notes: [
        "New action get_site_banner: the notice across the top of every public page, as { banner: { enabled, message, link_label, link_href } }. A banner nobody has set reads as enabled: false with empty strings. 503 settings_unreadable when it cannot be read, rather than an answer of off.",
        "New action save_site_banner: send any of enabled, message, link_label and link_href; what you leave out keeps its stored value, so {\"enabled\": false} turns the banner off and keeps its message for next time. It goes live from each visitor's next page load (moving between pages in a tab already open can keep the old one for a few minutes). The message is one line, up to 200 characters. The link is optional, but link_label and link_href come together, and link_href is a page on this site (/register-interest): an outside address can only be set on the manager's Site banner screen, and a banner whose stored link goes to another site can only be switched off here (409 outside_link for anything else, unless you replace the link with a page on this site). Returns the banner as saved.",
      ],
    },
    {
      version: "28",
      // Three new response fields; nothing that worked before changes.
      breaking: false,
      notes: [
        "get_user's profile carries first_name, middle_name and last_name: the person's name in its parts, as their record holds it. user.name is unchanged and is still the one to show.",
      ],
    },
    {
      version: "27",
      // One new response field; nothing that worked before changes.
      breaking: false,
      notes: [
        "list_invoices rows, each invoice inside list_users, and each membership inside get_user carry insurance_reminder. It is null on every plan except yearly insurance (a plan whose kind is insurance). On those it is { ends_within_14_days, owed, last_sent }: ends_within_14_days is true while the member is owed the 'ending soon' reminder (their cover ends in the next 14 club days, they have not renewed with another active insurance membership, and it is not cancelled); owed is the reminder owed today (insurance_ending_soon, insurance_ended, or null), sent or not; and last_sent is { kind, sent_at } for the latest reminder actually emailed, or null if none has gone out. The site sends both reminders itself every morning; there is no action to send or suppress one, and members cannot switch them off.",
      ],
    },
    {
      version: "26",
      // A new optional param and two new response fields. Nothing that worked
      // before changes: without `announce`, save_membership_plan does exactly
      // what it did, with `announcement: null` added to its response.
      breaking: false,
      notes: [
        "save_membership_plan takes `announce: true` plus an `announcement_id` (a UUID you mint) to email every member about the plan once it is saved, the same as the manager screen's \"Email all members about this plan\" box. It is sent straight away, one email per family, and nobody can switch it off. The response gains `announcement`: { announcement_id, recipients, emailed, pending, announced_at }, null when not announcing. Reuse the same announcement_id to retry or to finish a send that left `pending` above zero: nobody is emailed twice. A new id announces the plan again, on purpose. `announce: true` without an id is 400 `invalid_params` before anything is saved; an id already used for another plan is 409 `submission_conflict`; a saved plan whose email failed is 502 `announcement_failed` with the plan's id in `error.details` (retry with that id, so a plan you just created is not created again); an `id` that matches no plan is 404 `not_found`.",
        "list_membership_plans adds `last_announcement` to each plan: its most recent announcement ({ announcement_id, announced_at, recipients, emailed, times }), or null if it was never announced.",
      ],
    },
    {
      version: "25",
      // Purely additive: five new actions. Nothing that worked before changes.
      breaking: false,
      notes: [
        "New actions for the blog, the same writes the manager's blog editor makes: list_blog_posts and get_blog_post read posts, drafts included; save_blog_post creates a post or changes one, and publishes it when status is published; delete_blog_post deletes one for good; upload_blog_image stores a picture for a post, from base64 data or a public https url, and returns the path for cover_image_path and the markdown for body_md.",
        "A new post never takes an address another post already has: save_blog_post refuses with 409 slug_taken and names the post that has it, so a retried create cannot file the post twice or announce it twice. An edit refuses with 409 post_changed when the post was saved by somebody else after the edit read it, rather than writing back what it read over their change.",
        "Publishing is public and announced. The first time a post goes live, every member who opted in to announcements hears about it in their daily summary email, and taking the post back to draft does not take that back. On a change, save_blog_post keeps every field you leave out, so sending only status publishes a draft as it stands.",
      ],
    },
    {
      version: "24",
      // Four new actions and one new field. Nothing that worked before changes,
      // though what "outdated" means did move, which a caller acting on it
      // should read.
      breaking: false,
      notes: [
        "The code of conduct is now a document managers edit, in numbered versions with one live, like the waiver. New actions: list_code_of_conduct_versions, get_code_of_conduct, save_code_of_conduct and publish_code_of_conduct, with the same contract as the four waiver template actions: keyed on the version number, saving publishes, an omitted title/body is carried over from base_version (default the live one) and based_on names it, refusals are 404 not_found, 422 save_code_of_conduct_failed / publish_code_of_conduct_failed, and 503 code_of_conduct_not_published with Retry-After.",
        "save_code_of_conduct takes asks_reagreement (default false): whether this version asks everybody who agreed to an older one to agree again. Leave it off for a correction. The reply's reprompted says how many people it put out of date, and publish_code_of_conduct's reply carries the same count. It also takes client_submission_id: resend the same one on a retry and you get already_saved true and no second version. If that version is not live (it lost the publish, or the live version changed since), the retry is 503 code_of_conduct_not_published with details.version and nothing is made live: publish it yourself only if it should replace what is live now.",
        "code_of_conduct on list_users rows and in get_user carries required_version: the version people must have agreed to while the live one is live (the last version that asked everybody to agree again, unless a rollback undid that ask). state is now outdated only when accepted_version is below required_version, not below current_version, so a typo-fix version no longer puts anybody out of date. current_version is null if nothing is live.",
      ],
    },
    {
      version: "23",
      // A new read-only action and three new list_users fields. Nothing that
      // worked before changes.
      breaking: false,
      notes: [
        "New action get_user { user_id }: everything the manager person page shows about one person, read by the same function the page uses. user (name, email with email_belongs_to, email_confirmed_at, phone, roles, lifecycle_status, sessions_attended, the newest membership's kind and status), profile (contact details, date of birth, address, emergency contact, medical notes, the guardian block, kit sizes, photo consent), household, memberships, checkins (attendance, newest first), code_of_conduct, and waivers (approval status, template_version, signed_at, has_pdf, approver, and is_paper for a scanned paper form). A waiver's signer_ip and signer_meta are deliberately left out.",
        "get_user reports a person, not a lead: an id with no person record is 404 not_found. A read it could only half answer (the address, the code of conduct, the guardian's name, a class name or a waiver approver's name could not be read) is 500 db_error, never a null email, an `unsigned` or an unknown name it did not actually check.",
        "list_users rows carry phone, email_confirmed_at (null means the address is not verified; for a dependant it is the state of the guardian's address, like email itself) and code_of_conduct: { state: unsigned | signed | outdated, current_version, accepted_version, accepted_at, signature_name }. The same object get_user and the person page report.",
      ],
    },
    {
      version: "22",
      // Purely additive: one new action. Nothing that worked before changes.
      breaking: false,
      notes: [
        'New action resend_email: {"kind":"...","record_id":"<uuid>"} sends one email again to the person it went to (the guardian, for a child), rebuilt from today\'s records: an invoice carries the amount owed now and the club\'s current bank details, a waiver confirmation a fresh PDF link. kind is one of membership_invoice, membership_receipt, item_invoice, item_invoice_receipt (record_id: the invoice), waiver_confirmation, account_activated (record_id: the waiver), email_verification (record_id: the person).',
        "Each email for each record can be resent once a minute: a second call inside that is 429 rate_limited with a Retry-After. Pass client_submission_id (a UUID) and reuse it to retry one resend safely after a lost answer or a 503 email_not_sent; a new id is a new send. Reusing an id whose email already went, more than a minute later, is 409 already_sent rather than a second email.",
        "Refusals name what is wrong, as the error code: 404 not_found; 409 paid, unpaid, cancelled, not_approved, locked or already_verified when the record has moved on, checked again at the send (resend the receipt rather than the invoice, and so on); 409 already_sent for a reused client_submission_id; 422 paper, no_address, dependant or free when there is nothing that can be sent.",
      ],
    },
    {
      version: "21",
      // Purely additive: one new action. Nothing that worked before changes.
      breaking: false,
      notes: [
        "New action get_club_settings: the club's reply-to address (email_reply_to, or null) and its bank account (payment_details, or null when not published). The same values the manager's Club settings screen shows. 503 settings_unreadable when they cannot be read, rather than an answer of nothing set.",
        'Read-only: there is deliberately no action that changes either. They decide where members\' replies and money go, so a manager changes them on the Club settings screen. Once email_reply_to is set, every email the club sends to a member carries it as Reply-To and says "reply to this email"; while it is null, those emails point at the contact page instead.',
      ],
    },
    {
      version: "20",
      // Two new optional params and one new response field. A call that sends
      // neither param records exactly what it always did.
      breaking: false,
      notes: [
        "mark_invoice_paid and mark_item_invoice_paid take two optional params. paid_on (YYYY-MM-DD) is the day the money actually arrived, for cash taken earlier than it is being recorded; absent, an empty string or null means today; a future day, or one more than two years ago (a mistyped year), is refused with 400 invalid_params; and a day before the invoice was raised is allowed (backfilling a settled enrolment). paid_reference is what the payment was known by, such as a receipt number (up to 200 characters). It is NOT the invoice's payment_reference, which is what the member quotes on a transfer and is never changed by marking paid.",
        "Both are written only when the payment is recorded. On an invoice that is already paid the call still records nothing (recorded: false), so neither the date nor the reference of the first payment moves.",
        "list_invoices and list_item_invoices rows carry paid_reference: null unless a payment recorded by hand was given one.",
      ],
    },
    {
      version: "19",
      // Two new response fields; nothing that worked before changes.
      breaking: false,
      notes: [
        "create_membership now also returns `reused` and `price_cents`. `reused` is true when the person already had an unpaid invoice for that plan and it came back instead of a new one. That invoice keeps its price: a different uts_student_number does not reprice it. When `price_cents` is not the rate you meant, cancel or delete that invoice and raise the plan again, or correct the price with edit_invoice.",
      ],
    },
    {
      version: "18",
      // Purely additive: eight new actions. Nothing that worked before changes.
      breaking: false,
      notes: [
        "New actions for charging people for things that are not a membership (a gi, a patch, a grading fee): list_items, save_item and delete_item keep the club's price list (a name and a price, nothing else); list_item_invoices, create_item_invoice, mark_item_invoice_paid, cancel_item_invoice and delete_item_invoice raise and settle invoices from it. The same writes the manager's Items screen and a person's page make.",
        "An item invoice is NOT a membership and does not appear in list_invoices, edit_invoice or delete_invoice. Its reference looks like INV0007, is unique per invoice, and is settled by bank reconciliation the same way: a transfer carrying the reference and exactly the total.",
        "create_item_invoice prices each line off the price list at that moment and emails the invoice straight away (to the guardian, for a child). Pass client_submission_id and resend the same one on a retry: a retry of a raise that already landed returns that invoice with already_raised true and sends nothing.",
        "A paid item invoice is finished: cancel_item_invoice and delete_item_invoice refuse it with 409 item_invoice_settled, and there is no refund flow. Removing an item from the price list never changes an invoice already raised, because each invoice keeps its own copy of every line.",
      ],
    },
    {
      version: "17",
      // Two new response fields, AND a change in what an existing one means for
      // one kind of person -- which also moves which rows a `status` filter
      // returns. Not breaking (no call starts failing), but a caller that acted
      // on `lifecycle_status` or filtered on it gets different answers, so it is
      // the note that matters most to somebody holding a cached manifest.
      breaking: false,
      notes: [
        "list_users rows carry guardian_user_id: the id of the account holder this person is on, or null for almost everybody. email_belongs_to already NAMED that person; this identifies them, so you can fetch or act on the guardian rather than only mention them.",
        "list_users rows carry dependants: the people on this person's account, each with user_id and name. Always present and empty for almost everybody, including for a dependant, because a household is one level deep and a dependant can never have any. Read it rather than rebuilding the household from guardian_user_id across the listing: a `status` filter can drop the children out of the response while leaving the parent in it, and a household rebuilt from what came back would report that parent as having none.",
        "Approving a child's waiver unlocks the GUARDIAN's login, not the child's, and gives the trial to the child. A child never has a login. So `dependants` is how you find out that create_membership on a nine-year-old is a thing the club expects, and who to chase for the invoice it raises.",
        "list_users rows now report lifecycle_status and roles through the HOUSEHOLD for one branch: a person counts as a `member`, and carries the `member` role, while anybody on their account holds an active paid membership. So a parent who does not train reads as `member` rather than `lead` or `lapsed`. This matches what members-only access has done for them since the household shipped; it was the label that disagreed.",
        'That also moves which rows a status filter returns: list_users {"status":"lead"} no longer includes a non-training parent whose child is paid up, and {"status":"member"} now does. Re-read anything you cached that was filtered by status.',
        "Only that branch reaches. `lapsed` is still the person's own, so a parent whose own plan ended is still somebody to chase. And `member` is still only a LABEL: no policy reads the member role, and it does not mean they are covered to train. Check-in coverage is strictly the person's own, so a parent at the door correctly shows no cover.",
      ],
    },
    {
      version: "16",
      // Additive: two new response fields, and a change in what an existing
      // one MEANS for one kind of person. Every call that worked before still
      // works; a caller that ignores the new fields is not broken, it is just
      // missing the caption.
      breaking: false,
      notes: [
        "A person on somebody else's account (a child, typically) has no mailbox of their own, so the `email` on their `list_users` row and the `member_email` on their `list_invoices` row are the GUARDIAN's address, not theirs. This was already true of what the club sends; it is now true of what these actions report.",
        "list_users rows carry email_belongs_to, and list_invoices rows carry member_email_belongs_to: the name of the person whose address it is, or null when it is the person's own. Do not report an address to anybody without it. An address under a child's name with no caption reads as a mailbox you can write to, and nobody is reading it.",
        "member_email_belongs_to is a read-only decoration like member_name and plan_name. edit_invoice rejects it by name, so send only `id` and the fields you are changing rather than echoing a listed invoice back.",
      ],
    },
    {
      version: "15",
      // Additive: one new optional param on file_waiver, and one existing param
      // that stops being required only when that param says so. Every call that
      // worked before still works and still means the same thing.
      breaking: false,
      notes: [
        'file_waiver takes signing_for: "self" (the default, and what every existing call means) or "dependant", for a person on somebody else\'s account, typically a child. A dependant gets their own person record with their own waiver, trial and attendance, and no login ever, which is what lets a family file one form per child under one address instead of the second overwriting the first.',
        'With signing_for: "dependant", email is REFUSED rather than required: a dependant has none of their own. guardian_email and guardian_name become required instead, because the guardian is who the club writes to and whose login approving the waiver opens. email stays required for the default "self".',
        "Which existing child a dependant filing belongs to is decided by matching first_name, last_name and date_of_birth within that guardian's household, so spell them the same way each time or a second person is created. The duplicate-waiver check for a dependant looks at that child's own waivers, not the guardian's.",
        "A guardian who is themselves somebody's dependant is refused: a household is one level deep.",
      ],
    },
    {
      version: "14",
      // Additive: one new optional param on each of two actions, and two fields
      // that were always in the response are now editable. Nothing that worked
      // before fails or means anything different.
      breaking: false,
      notes: [
        "create_membership takes starts_on: the day the membership itself runs from, defaulting to today. Only a plan that runs for a fixed number of days takes one, which today means the yearly insurance, so it is what backdating somebody's cover to when it really began needs. Sending it for a training period (whose dates belong to the plan and are shared by everyone who buys it) or for a class-credit plan (which ends with its classes, not on a date) is refused with 422 start_date_not_choosable rather than ignored.",
        "edit_invoice takes starts_on too, for correcting that day afterwards. It writes starts_at AND ends_at: the window keeps the length it was sold at and moves as one, so a correction can never lengthen or shorten somebody's cover. Both appear in `changed` and `previous`, and in the audit log, like any other edit. Same 422 start_date_not_choosable on a plan with no start date to set.",
        "starts_at / ends_at are deliberately NOT guarded by confirm_paid_edit. They record when somebody is covered, not what they paid, and the correction is most often wanted precisely because the money has already landed.",
        "Re-raising the same person and plan with create_membership still reuses their existing unpaid invoice, and now moves that invoice's window when the starts_on you send differs from the one it holds.",
      ],
    },
    {
      version: "13",
      // Additive: a new response field and a new piece of markdown syntax.
      // Nothing that worked before fails or means anything different, and an
      // article with no `{#anchor}` in it behaves exactly as it did.
      breaking: false,
      notes: [
        "Articles can link to a SECTION of another article. Every heading has an anchor, and an ordinary markdown link carries it: [how grading works](/kb/belts#how-grading-works). The anchor is the heading's own words, lowercased with hyphens for anything else.",
        "get_kb_article gained `sections`: every heading in the version you read, with its `id`, `text`, `depth`, `pinned` flag and ready-made `url`. Read the target article and use the `url` it reports rather than deriving a fragment from the heading yourself.",
        "A heading can PIN its anchor with the attribute syntax `## How grading works {#grading}`, which fixes the link so rewording the heading later does not break it. The suffix is stripped when the article is rendered, and `sections[].pinned` says which anchors were set this way. Prefer pinning any heading you have just linked to from somewhere else.",
        "A link to a section that no longer exists is not silently ignored: the reader is told the section is gone and shown what the article has now.",
      ],
    },
    {
      version: "12",
      // Five new optional fields on one action. Nothing that worked before
      // fails or means anything different, so a client that ignores them is
      // still correct -- it just files a minor's guardian less completely.
      breaking: false,
      notes: [
        "file_waiver takes the parent or legal guardian of a minor as their own person, separate from the emergency contact: guardian_name, guardian_relationship, guardian_address, guardian_phone and guardian_email, all optional. They are two people who may be the same one, not one person by definition, so a form that names the signer apart from the emergency contact can now be filed as it actually reads. Omit an address, mobile or email that is the participant's (the participant's is stored for the guardian too), and omit the lot for an older form with a single contact block, where that contact is still taken as the signer exactly as before.",
        "emergency_contact_relationship is still required for a minor, but guardian_relationship now satisfies that requirement instead, so a filing that gives the guardian's relationship and leaves the emergency contact's blank is accepted where it used to be refused.",
        "guardian_email is evidence on the waiver and is never used to identify anybody. The person record stays keyed on the participant's email, so a guardian_email the club has never seen does not create a second person.",
      ],
    },
    {
      version: "11",
      // Purely additive: four new actions, no existing one changed shape.
      breaking: false,
      notes: [
        "New actions list_waiver_templates, get_waiver_template, save_waiver_template and publish_waiver_template: the waiver everyone signs is now editable through this API, the same way /manager/waiver-template edits it. They key on the VERSION NUMBER, not a row id.",
        "save_waiver_template writes a new version and PUBLISHES it in the same call, because that is what saving means on the manager screen: there is no draft state. Waivers already signed keep the version they were signed against.",
        "save_waiver_template carries over anything you omit from the version the edit starts from, so acknowledgements can be reworded without resending the body. title and body_md must arrive together, and a call naming neither text nor acknowledgements is refused rather than republishing an identical copy.",
        "Every version must carry the `media` acknowledgement with real wording: it is what records who agreed to photos, and a save or publish without it is refused with 422 rather than quietly ending the club's consent record.",
        "save_waiver_template and publish_waiver_template answer 503 waiver_template_not_published with a Retry-After when the change did not reach the live waiver (a concurrent promotion, most often). Retry it. When error.details.version is present, that version WAS written and is only unpublished — finish with publish_waiver_template on it rather than saving again, which would file a second draft.",
      ],
    },
    {
      version: "10",
      // Authorising a membership and paying for one used to be the same act.
      // Splitting them changes what `status` means and what `create_membership`
      // hands back, so a client that branched on either behaves differently.
      breaking: true,
      notes: [
        "A membership's `status` no longer says anything about money. `active` now means AUTHORISED TO TRAIN, and a membership is authorised the moment it is raised, with its invoice outstanding. Whether it has been paid for is `paid_at`, which is written only when a payment is actually recorded. Read `paid_at`, never `status`, to tell who owes the club money.",
        "`pending` is no longer produced by anything. Rows created before this still carry it and are unpaid in exactly the same way as any other unpaid row, so filter on `paid_at` rather than listing statuses.",
        "create_membership returns `authorised: true` in place of `activated`, and the membership it raises is already authorised whatever the plan costs. Its invoice is what is outstanding, and `reference` is non-null exactly when money is owed.",
        "New action mark_invoice_paid: record a payment against an invoice, for money that never touches the club account (cash at the door). It is idempotent — a second call on an already-paid invoice records nothing and re-sends nothing — and it emails the member a receipt. This is the manual counterpart to bank reconciliation, and it is what makes an invoice permanently undeletable.",
        "delete_invoice no longer refuses on `active`, because every membership is active now and that blocker would have made every delete a two-step. The remaining blockers are `paid` and `attended`. A call that used to be refused with `active` can now succeed.",
      ],
    },
    {
      version: "9",
      // Two new actions, and one existing action quietly doing more. Nothing
      // that worked before fails or means something different.
      breaking: false,
      notes: [
        "New action create_membership: raise a pending invoice for a person, the manager's counterpart to a member choosing a plan on the site. Unlike a member's own purchase it can use a plan that is no longer on sale (backfilling a past training period), its include_insurance answer is final rather than enforced, and send_email: false records the invoice without telling them about it. A priced plan always lands pending — activating it grants the member role and emails them, and stays a separate deliberate step. A FREE plan (the trial) activates immediately, exactly as it does when a member chooses it themselves; the result's `activated` says which happened.",
        "New action delete_invoice: delete an invoice outright. Refused with 409 invoice_not_deletable when a payment is recorded against it, it is still active, or a class was checked in against it; error.details.blockers lists every reason at once (paid | active | attended) so clearing one does not walk into the next. A paid invoice is never deletable — cancel it instead, via edit_invoice. Moving a check-in off a membership is UI-only for now, so an 'attended' blocker cannot be cleared through this API.",
        "edit_invoice: setting status to cancelled or expired now also reconciles the person's `member` role, so list_users stops reporting somebody as a member once their last paid membership closes. Members-only ACCESS was already gated live and is unaffected; this only corrects the label, which used to be granted and never taken back.",
      ],
    },
    {
      version: "8",
      // Purely additive: one new optional param on an existing action. Nothing
      // already working starts failing or means something different.
      breaking: false,
      notes: [
        "file_waiver: accepts media_consent, the same as sms_whatsapp_consent — true, false, or omitted if the paper form never asked about photo/video use. Omit rather than guessing; a false records a refusal the club never received.",
      ],
    },
    {
      version: "7",
      // A membership window is no longer a concept separate from the plan
      // that sells it: each dated training period is now its own
      // membership_plans row, carrying its own price, starts_on and ends_on.
      // The two actions that managed the old separate table are renamed with
      // no aliases, so any client that cached them 400s on unknown_action.
      breaking: true,
      notes: [
        "RENAMED, with no aliases: list_membership_windows -> list_membership_plans, save_membership_window -> save_membership_plan. list_membership_plans returns every plan the club sells (dated and undated alike), not just the club's training windows.",
        "save_membership_plan creates or updates a plan directly: code, name, price, kind, and either starts_on/ends_on (a fixed date range) or duration_days (a rolling window from payment) — never both. There is no year/half upsert key any more: code is supplied by the caller like any other plan field, and an unknown code creates a new plan.",
        "list_invoices / edit_invoice's returned invoice, and each invoice inside list_users, no longer carry semester_code / semester_name — the invoice's plan_name already names the period it was bought for (e.g. 'Semester 2 2026'), since a dated period is now a plan in its own right rather than a separate table an invoice points at.",
      ],
    },
    {
      version: "6",
      // The semester concept was folded into "membership windows" (the period
      // plan IS a windowed membership). Both semester actions were RENAMED with
      // no aliases, so any client that cached them 400s on unknown_action.
      breaking: true,
      notes: [
        "RENAMED, with no aliases: list_semesters -> list_membership_windows, save_semester -> save_membership_window. Same params, same response shape. The club's fixed training dates are now called membership windows: the period membership plan always runs exactly one chosen window.",
        "Purchases on the site may now bundle the yearly insurance as a second invoice sharing the same payment reference (insurance is mandatory when a member has no current cover). list_invoices / edit_invoice show such pairs the same way as any other two invoices sharing a reference.",
      ],
    },
    {
      version: "5",
      // Purely additive: two new actions, and a decorative field on existing
      // ones. Nothing already working starts failing or means something
      // different.
      breaking: false,
      notes: [
        "New actions list_semesters and save_semester. The `semester` membership plan now runs for a fixed, club-set semester date range instead of a rolling window from payment date; these actions manage the club's semester dates the same way list_kb_sections/save_kb_section manage the knowledge base's sections.",
        "list_invoices / edit_invoice's returned invoice, and each invoice inside list_users, now carry semester_code and semester_name — set when the invoice is for a semester-anchored plan, null otherwise.",
      ],
    },
    {
      version: "4",
      // `visibility: "public"` is now refused by the schema, so a client that
      // sends it on every save (rather than omitting it, as the guidance has
      // always said) starts failing. That is a 422, not a silent downgrade.
      breaking: true,
      notes: [
        "The knowledge base is signed-in only, reached from the member area. `visibility` lost its `public` level: it is now members | managers, and any article that was public is now members. Sending 'public' is refused.",
        "New action delete_kb_section. Deleting a section leaves its articles in place, in the 'Everything else' group, and reports how many were displaced.",
        "list_kb_articles is unchanged in shape, but no article can report visibility 'public' any more.",
      ],
    },
    {
      version: "3",
      // Every document action was renamed, so every call a cached client makes
      // to one of them now 400s on an unknown action. There is no aliasing and
      // no version pinning: this is the one bump where "re-read when convenient"
      // is wrong advice.
      breaking: true,
      notes: [
        "Club documents are now the knowledge base, served at /kb/<slug> rather than /docs/<slug>. The old paths are gone.",
        "RENAMED, with no aliases: list_documents -> list_kb_articles, get_document -> get_kb_article, save_document -> save_kb_article, list_document_annotations -> list_kb_comments. Calling an old name is a 400 unknown_action.",
        "Annotations report `article_version` where they used to report `document_version`.",
        "New actions list_kb_sections and save_kb_section. Articles now live in ordered sections, and that order is what members read through.",
        "save_kb_article: title and body_md are now OPTIONAL. Sending neither changes only the article's placement and writes NO new version; sending one without the other is refused. `version` in the result is null when no version was written.",
        "save_kb_article: accepts section, position, nav_title and link_path. An unknown section slug is refused rather than dropping the article out of the sidebar.",
        "save_kb_article: link_path makes the entry a sidebar LINK to another page on this site instead of an article. It needs a nav_title, refuses title/body_md, and an existing article that already has versions cannot be turned into one.",
      ],
    },
    {
      version: "2",
      // A bare counter cannot say "this one can break you". Both refusals below
      // turn calls that used to succeed into errors, sitting next to additions
      // that harm nobody, and a client needs to tell "re-read when convenient"
      // from "stop now" without parsing prose.
      breaking: true,
      notes: [
        "edit_invoice: price_cents / payment_reference / payment_method on a PAID invoice are refused with 409 reconciled_invoice unless confirm_paid_edit is true. A call that used to succeed can now fail.",
        "edit_invoice: the result gained `changed` and `previous`.",
        "edit_invoice: an edit is refused with 409 invoice_changed if the invoice moved between the read and the write, so a `previous` you are shown is never stale.",
        "Every response now carries `version`, and error detail moved from the top of `error` into `error.details`.",
        "file_waiver: the duplicate check now matches ANY waiver signed on that UTC day, including one signed online, not only another paper filing.",
        "file_waiver: an unknown param is now a 400 rather than being silently dropped, so a misspelled confirm_duplicate cannot look like it was sent.",
        "file_waiver: a second waiver for the same person and signed_on is refused with 409 duplicate_waiver unless confirm_duplicate is true. A call that used to succeed can now fail.",
        "file_waiver: a failed duplicate check is 503 duplicate_check_failed; nothing was filed and the call is safe to retry unchanged.",
        "file_waiver: accepts client_submission_id, which makes a retry safe. Send one per record in any bulk import; the result's `created` says whether that call filed the waiver or replayed an earlier one.",
        "file_waiver: a half-filed waiver (scan not stored) is 503 waiver_filing_incomplete with Retry-After — the row is KEPT and only a retry with the same id completes it. An id bound to another record is 409 submission_id_conflict and will never succeed.",
        "file_waiver: client_submission_id draws from one namespace covering every waiver, paper and online, and every caller — not one scoped per token. It only ever resolves back to another paper filing, so a collision with an online signature is safe (409 submission_id_conflict), but two separate imports sharing the same id scheme can collide with each other. Prefer a random id per record.",
        "list_users / list_invoices: every invoice gained sessions_allowed and sessions_remaining.",
      ],
    },
    { version: "1", breaking: false, notes: ["First published action set."] },
  ],
  actions: [
    {
      name: "list_users",
      method: "POST",
      summary:
        "List everyone in the club's funnel (leads, applicants, visitors, members) with their lifecycle status, roles, invoices, and how many classes they have attended (sessions_attended, lifetime across all plans). Each invoice carries its own sessions_allowed (the plan's session credits, e.g. 2 for a trial_2_session plan) and sessions_remaining (this invoice's own live balance, spent one per check-in) — use those, not sessions_attended, to answer 'how much of this trial is left'. sessions_allowed is null for a plan with no session credits (e.g. a period plan); sessions_remaining is ALSO null for a still-pending invoice on a session-credit plan (it's set on activation) — null there means not started yet, not zero remaining. Each row also carries phone, email_confirmed_at (null = not verified) and code_of_conduct (the same object get_user reports). For anything more about one person (profile, waivers, attendance), call get_user. A yearly insurance invoice also carries insurance_reminder (see list_invoices).",
      params: [
        {
          name: "status",
          required: false,
          description: "Filter by lifecycle status: lead | applicant | visitor | member | lapsed.",
        },
        {
          name: "limit",
          required: false,
          description: "Max users to return (1-500, default 200).",
        },
      ],
    },
    {
      name: "get_user",
      method: "POST",
      summary:
        "Everything the manager person page (/manager/users/<id>) shows about one person, from the same read: `user` (headline: name, email + email_belongs_to, email_confirmed_at, phone, roles, lifecycle_status, sessions_attended, latest_plan_kind, latest_membership_status, latest_sessions_remaining, first_seen_at), `profile` (the club's live record: first, middle, last and preferred name, date of birth, address, UTS student number, emergency contact, medical notes, is_minor and the guardian block, SMS/WhatsApp consent, gi and belt size, media_consent with who set it and when), `household` (guardian and dependants, by id and name), `memberships` (each with plan_name, kind, status, price_cents, payment_reference, dates, sessions_remaining, paid_at, checkin_count and insurance_reminder (see list_invoices); list_users' `invoices` carries the money detail such as payment_method and notes), `checkins` (attendance, newest first, capped at 100; `user.sessions_attended` is the exact total), `code_of_conduct` (state unsigned | signed | outdated, current_version, accepted_version, accepted_at, signature_name), and `waivers` (every submission as signed, with status, template_version, signed_at, has_pdf, approved_at, approver, and is_paper: true for a scanned paper form filed by a manager). As on list_users, a dependant's `email` is their guardian's and `email_belongs_to` says so: report the two together or neither. Read-only. A lead has no person record, so 404 not_found; a read that could not fill any part (the address, the code of conduct, a name) is 500 db_error rather than a guess; retry it.",
      params: [
        {
          name: "user_id",
          required: true,
          description: "The person's user UUID, from list_users.",
        },
      ],
    },
    {
      name: "list_invoices",
      method: "POST",
      summary:
        "List invoices (membership payment records) with member name/email — useful to find an invoice id to edit. Each carries paid_at and paid_reference (what a payment recorded by hand was known by), and sessions_allowed and sessions_remaining; read the list_users summary for what null means on each (they are not interchangeable with zero). Each also carries insurance_reminder: null unless the plan is yearly insurance, otherwise { ends_within_14_days, owed, last_sent } — whether the member is owed the 'insurance ends soon' reminder today, which reminder is owed today, and the latest reminder emailed ({ kind: insurance_ending_soon | insurance_ended, sent_at }) or null. The same thing the memberships screen shows as '14-day reminder sent 26 Feb'.",
      params: [
        {
          name: "status",
          required: false,
          description: "Filter by invoice status: pending | active | expired | cancelled.",
        },
        {
          name: "limit",
          required: false,
          description: "Max invoices to return (1-500, default 200).",
        },
      ],
    },
    {
      name: "create_membership",
      method: "POST",
      summary:
        "Raise a membership for a person against a plan — the manager's counterpart to a member choosing a plan on the site. It is AUTHORISED immediately, whatever the plan costs: they can be checked in from that moment, with the invoice outstanding. Paying is a separate event (see mark_invoice_paid, or bank reconciliation); `reference` in the result is non-null exactly when money is owed, and carries what the member would quote on a transfer. Unlike a member's own purchase it accepts a plan that is no longer on sale, which is what backfilling a past training period needs. Re-raising the same person + plan reuses their existing UNPAID invoice rather than creating a second one, so a retry is safe. The free trial is still once per person, ever.",
      params: [
        {
          name: "user_id",
          required: true,
          description: "The person's user UUID, from list_users.",
        },
        {
          name: "plan_code",
          required: true,
          description: "Plan code from list_membership_plans. May be a plan no longer on sale.",
        },
        {
          name: "uts_student_number",
          required: false,
          description:
            "Their UTS student number. Its presence is what applies the student rate — there is no separate flag, and the price is computed server-side.",
        },
        {
          name: "session_date",
          required: false,
          description:
            "YYYY-MM-DD, for a casual class only, so the payment reconciles to that session. Defaults to today; ignored by every other plan kind.",
        },
        {
          name: "starts_on",
          required: false,
          description:
            "YYYY-MM-DD, the day the membership runs from. Defaults to today. Only a plan that runs for a fixed number of days takes one (the yearly insurance): its length is fixed but where it sits is a real choice, which is what backdating cover to when it actually began needs. The end date follows from the plan's duration. Refused with 422 start_date_not_choosable on a training period (its dates belong to the plan and everyone who buys it shares them) or a class-credit plan (it ends with its classes, not on a date).",
        },
        {
          name: "include_insurance",
          required: false,
          description:
            "Bundle yearly insurance as a second invoice on the same payment reference (default false). A member buying for themselves cannot decline this without current cover; a manager can, because recording an enrolment that really happened without cover is history, not a sale. A bundled insurance invoice always runs from today, never from starts_on: it is a second plan being sold now.",
        },
        {
          name: "send_email",
          required: false,
          description:
            "Email them the payment instructions (default true). Set false when backfilling something already settled, so nobody is invoiced for last semester.",
        },
      ],
    },
    {
      name: "edit_invoice",
      method: "POST",
      summary:
        "Correct an invoice's detail fields. Returns the updated invoice plus `changed` (the fields that actually moved) and `previous` (what they held before). Cannot set status to 'active' — activation grants the member role and emails the member, so it runs through bank reconciliation, not here. On an invoice that has been PAID (paid_at set), price_cents / payment_reference / payment_method describe money that already moved: they are refused with 409 reconciled_invoice unless confirm_paid_edit is true. A refusal is atomic — NOTHING is written, including any unguarded field sent in the same call — and `error.details.previous` covers only the `blocked` fields. Every edit is written to the server audit log (who, when, field, old -> new).",
      params: [
        { name: "id", required: true, description: "Invoice (membership) UUID." },
        { name: "price_cents", required: false, description: "Amount owed, integer cents." },
        {
          name: "notes",
          required: false,
          description: "Free-text manager notes. Pass null to clear it.",
        },
        {
          name: "payment_reference",
          required: false,
          description: "Bank-transfer reference the member should quote.",
        },
        {
          name: "payment_method",
          required: false,
          description: "bank_transfer | stripe | manual.",
        },
        { name: "status", required: false, description: "pending | cancelled | expired." },
        {
          name: "starts_on",
          required: false,
          description:
            "YYYY-MM-DD, the day this membership runs from. Writes starts_at AND ends_at: the window keeps the length it was sold at and moves as one, so a correction cannot lengthen or shorten the cover. Only on a plan whose start is a real choice (the yearly insurance) - anything else is refused with 422 start_date_not_choosable. Not guarded by confirm_paid_edit: dates say when somebody is covered, not what they paid.",
        },
        {
          name: "confirm_paid_edit",
          required: false,
          description:
            "Set true to allow price_cents / payment_reference / payment_method to be rewritten on an invoice that has already been paid. Not a field to write, and a no-op on an unpaid invoice.",
        },
      ],
    },
    {
      name: "mark_invoice_paid",
      method: "POST",
      summary:
        "Record a payment against an invoice, for money that never touches the club account — cash at the door, or a transfer settled some other way. Bank reconciliation does this automatically when a statement line matches, so reach for this only when it cannot. It emails the member a receipt, and it is what makes the invoice permanently undeletable, so record it only once the money has actually arrived. Idempotent: a second call on an already-paid invoice records nothing, moves no date and sends no second receipt, and comes back with `recorded: false`. Refused on a free membership, which has nothing to pay. paid_on and paid_reference record when the money arrived and what it was known by.",
      params: [
        { name: "id", required: true, description: "Invoice (membership) UUID." },
        {
          name: "payment_method",
          required: false,
          description:
            "bank_transfer | stripe | manual. Defaults to manual, which is what an invoice the reconciler could not see almost always is — say bank_transfer only when a real transfer landed and you are recording it by hand.",
        },
        {
          name: "paid_on",
          required: false,
          description:
            'YYYY-MM-DD, the day the money arrived, in the club\'s timezone. Defaults to today (also when sent as "" or null). A future day is refused, and so is one more than two years ago (a mistyped year); an earlier one, even before the invoice was raised, is accepted.',
        },
        {
          name: "paid_reference",
          required: false,
          description:
            "What the payment was known by, such as a receipt number or the transfer's own reference (up to 200 characters). Not the invoice's payment_reference, which this never changes.",
        },
      ],
    },
    {
      name: "delete_invoice",
      method: "POST",
      summary:
        "Delete an invoice outright, for tidying up one that should never have existed. Refused with 409 invoice_not_deletable when a payment is recorded against it, or when a class was checked in against it; error.details.blockers names EVERY reason at once (paid | attended) so clearing one does not walk into the next. Being active is NOT a blocker: every membership is authorised from the moment it is raised, so that would refuse everything. A paid invoice is never deletable and there is no confirm flag to force it — cancel it instead via edit_invoice, which closes it and keeps the club's record of the money. An 'attended' blocker is cleared by moving those check-ins to another membership, which is a manager-screen action and not available through this API.",
      params: [{ name: "id", required: true, description: "Invoice (membership) UUID." }],
    },
    {
      name: "file_waiver",
      method: "POST",
      summary:
        "File a waiver from a scanned paper form — for migrating records the club already holds on paper, or any waiver signed outside the site. Same params as the manager's paper-upload form. Attaches to the person with this email, or creates one. Lands PENDING: it does not approve, email anyone, or mark the email verified — a separate edit_invoice-style approval step is a manager's own call, not this endpoint's. A person's ACTIVE waiver is their most recently APPROVED one, not most recently signed, so approving a backlog out of chronological order changes who looks active. Refiling the same person + signed_on is refused with 409 duplicate_waiver (the existing waiver ids come back in `error.details.existing`, with `details.truncated` true if there are more than 20); pass confirm_duplicate to file it anyway. If the duplicate check itself fails, you get 503 duplicate_check_failed with a Retry-After header and NOTHING was filed — retry it, do not reach for confirm_duplicate. To make retries safe, send client_submission_id.",
      params: [
        { name: "first_name", required: true, description: "As written on the form." },
        { name: "middle_name", required: false, description: "As written on the form." },
        { name: "last_name", required: true, description: "As written on the form." },
        {
          name: "preferred_name",
          required: false,
          description: "What they go by, if different from first_name.",
        },
        { name: "date_of_birth", required: true, description: "YYYY-MM-DD." },
        {
          name: "address_parts",
          required: false,
          description:
            'The participant\'s address in parts, as the online form takes it: { street, suburb, state, postcode }. state is one of ACT, NSW, NT, QLD, SA, TAS, VIC, WA; postcode is four digits; suburb has no digits or commas; street is everything before the suburb, unit included. The stored line is composed from these as "<street>, <suburb> <STATE> <postcode>". Send this, or address.',
        },
        {
          name: "address",
          required: false,
          description:
            "The participant's address as one line, as written on the form. Only for a paper address you cannot split into address_parts: it is stored as written, and the person is asked for the parts the next time they give an address. Ignored when address_parts is sent. One of the two is required.",
        },
        { name: "phone", required: true, description: "As written on the form." },
        {
          name: "signing_for",
          required: false,
          description:
            'Who the paper is for: "self" (the default, and every previous call) or "dependant" for somebody on another person\'s account, typically a child. A dependant gets their own person record and never a login; the guardian below is who the club writes to and whose login approval opens. Which existing child it attaches to is matched on first_name, last_name and date_of_birth within that guardian\'s household.',
        },
        {
          name: "email",
          required: true,
          description:
            'Identifies the person: an address the club already knows attaches to that person, a new one creates one. A typo makes a second person. Required for signing_for "self"; REFUSED for "dependant", who has no address of their own, where guardian_email is given instead.',
        },
        {
          name: "uts_student_number",
          required: false,
          description: "Non-empty unlocks the student rate.",
        },
        {
          name: "sms_whatsapp_consent",
          required: false,
          description: "Whether they ticked SMS/WhatsApp consent on the form. Default false.",
        },
        {
          name: "media_consent",
          required: false,
          description:
            "Whether they ticked photo/video consent on the form: true, false, or omitted if the form never asked. Omit rather than guessing — false records a refusal the club never received.",
        },
        { name: "emergency_contact_name", required: true, description: "As written on the form." },
        {
          name: "emergency_contact_relationship",
          required: false,
          description:
            "Optional for an adult; REQUIRED if the participant was under 18 on signed_on, unless guardian_relationship is given instead.",
        },
        {
          name: "emergency_contact_phone",
          required: true,
          description: "As written on the form.",
        },
        {
          name: "guardian_name",
          required: false,
          description:
            'The parent or legal guardian who signed a minor\'s form, when the paper names them separately from the emergency contact. Omit for an older form with only one contact block: that contact is then taken as the signer. REQUIRED for signing_for "dependant", where the guardian is the whole point of the filing.',
        },
        {
          name: "guardian_relationship",
          required: false,
          description: "How the guardian is related to the participant, e.g. Mother, Father.",
        },
        {
          name: "guardian_address_parts",
          required: false,
          description:
            "The guardian's address in parts, in the same shape as address_parts. Omit when it is the same as the participant's; the participant's is stored for them.",
        },
        {
          name: "guardian_address",
          required: false,
          description:
            "The guardian's address as one line, only when it cannot be split into guardian_address_parts. Ignored when guardian_address_parts is sent.",
        },
        {
          name: "guardian_phone",
          required: false,
          description: "The guardian's mobile. Omit when it is the participant's.",
        },
        {
          name: "guardian_email",
          required: false,
          description:
            'The guardian\'s email. Omit when it is the participant\'s. For signing_for "self" it is evidence only, never used to identify anybody: the account stays keyed on the participant\'s email above. For "dependant" it is REQUIRED and it IS the identifying address, because the participant has none: it resolves the guardian (creating their locked person record if this is their first child), it is what the club writes to, and approving the waiver opens that login.',
        },
        {
          name: "medical_notes",
          required: false,
          description: "Details of anything answered yes on the health declaration, if noted.",
        },
        {
          name: "signed_on",
          required: true,
          description:
            "YYYY-MM-DD, the date on the paper (not today). Determines minority and list ordering, not which waiver is active.",
        },
        {
          name: "template_version",
          required: false,
          description: "Which form version this is, if known. Null/omit for an unplaceable form.",
        },
        {
          name: "scan",
          required: true,
          description:
            "Array of { name, type, data }, 1-20 files, type is application/pdf | image/png | image/jpeg, data is raw base64 (no data: prefix). Joined into one PDF in array order. 10 MB decoded total across all files in this call.",
        },
        {
          name: "confirm_duplicate",
          required: false,
          description:
            "Set true to file even though this person already has a waiver signed on this date. Default false. Only use it when the second document is real (a corrected re-scan) — not to push a retried import past the check.",
        },
        {
          name: "client_submission_id",
          required: false,
          description:
            "Your own UUID for this filing attempt, minted once per record and RESENT UNCHANGED on every retry of it. This is what makes retrying safe: the same id always resolves to the same waiver, so a call whose reply you never saw can be repeated without filing twice. The duplicate check alone cannot catch two retries racing each other; this can. Send one per record in any bulk import. A new id means a new waiver, and an id already used for a different record is refused (409 submission_id_conflict). NOTE: sending an id means you own finishing that record — a filing that fails with 503 waiver_filing_incomplete leaves a waiver with no document, which only your retry completes.",
        },
      ],
    },
    {
      name: "list_waiver_templates",
      method: "POST",
      summary:
        "List every stored version of the waiver members sign, newest first, saying which one is LIVE. Versions are the club's legal record: each signed waiver names the version it was signed against, and old versions are kept forever for that reason. Bodies are not included here — read one with get_waiver_template.",
      params: [],
    },
    {
      name: "get_waiver_template",
      method: "POST",
      summary:
        "Read one version's full markdown and its acknowledgements. Returns the LIVE version unless you name one. Read this before saving an edit: save_waiver_template writes the body as a whole, so an edit built without reading first silently drops every clause it did not include. The body carries {{placeholder}} tokens (full_name, date_of_birth, signature_name, ...) filled in per signer — leave the ones you are not deliberately changing exactly as they are.",
      params: [
        {
          name: "version",
          required: false,
          description: "Read a specific version instead of the live one.",
        },
      ],
    },
    {
      name: "save_waiver_template",
      method: "POST",
      summary:
        "Write a NEW version of the waiver and make it the one everyone signs, from that moment. Saving IS publishing here — there is no draft state, exactly as on the manager screen — so this changes the legal document the club puts in front of people: show a manager what you are changing before you call it. Waivers already signed keep the version they were signed against and are unaffected. Anything you omit is carried over from the version the edit starts from (the live one unless base_version names another), so an acknowledgement can be reworded without resending the body; title and body_md must arrive together. A 503 waiver_template_not_published means the version may exist without being live: retry, and if error.details.version names one, publish THAT rather than saving again.",
      params: [
        {
          name: "title",
          required: false,
          description:
            "The document's heading. Required with body_md when writing text; omit both to change only the acknowledgements.",
        },
        {
          name: "body_md",
          required: false,
          description:
            "The whole waiver as markdown, up to 30000 characters. This REPLACES the previous body; {{placeholder}} tokens in it are filled in per signer.",
        },
        {
          name: "acknowledgements",
          required: false,
          description:
            "The tick-boxes the signer accepts, as a list of { id, label, required }. REPLACES the previous list, so send it whole. It must still contain the `media` item with real wording: that one also records who agreed to photos, and a version without it is refused. Omit to keep the list as it is.",
        },
        {
          name: "base_version",
          required: false,
          description:
            "Which stored version this edit starts from, and therefore what an omitted field is carried over from. Defaults to the live one. Name an older version to bring back its wording with your edit on top.",
        },
      ],
    },
    {
      name: "publish_waiver_template",
      method: "POST",
      summary:
        "Make an existing stored version the live one, for rolling back to wording the club already agreed. Nothing is rewritten and no new version is created. Waivers already signed keep the version they were signed against, so this changes what the NEXT person signs and nothing else. Calling it on the version that is already live does nothing and reports published: false.",
      params: [
        {
          name: "version",
          required: true,
          description: "The version number to make live, as reported by list_waiver_templates.",
        },
      ],
    },
    {
      name: "list_code_of_conduct_versions",
      method: "POST",
      summary:
        "Every stored version of the club's code of conduct, newest first, without the text: version, title, is_current, status (Live | Previous | Draft, the editor's own word; Previous means it has been live, so a version rolled away from is still Previous), asks_reagreement (whether publishing it asked everybody to agree again), required_version (the version people must have agreed to while it is live) and first_published_at. Also live_version (null means nobody can read or agree to it right now) and required_version (anybody whose highest agreement is below it is out of date).",
      params: [],
    },
    {
      name: "get_code_of_conduct",
      method: "POST",
      summary:
        "One version's full text: title, body_md (a small markdown subset: # Heading, ## Section, - bullet, **bold**, bare https:// links, blank line between paragraphs), asks_reagreement, is_current. The live one when no version is named, which is the is_current row, not the newest: they differ after a rollback.",
      params: [
        {
          name: "version",
          required: false,
          description: "The version number. Defaults to the live one.",
        },
      ],
    },
    {
      name: "save_code_of_conduct",
      method: "POST",
      summary:
        "Write a new version of the code of conduct and make it live on /code-of-conduct straight away (saving publishes; there is no draft). An omitted title/body_md is carried over from base_version, default the live one; title and body_md travel together. asks_reagreement (default false) decides whether everybody who agreed to an older version is now out of date: leave it off for a correction, turn it on when the rules change. The reply carries reprompted, how many people it put out of date (normally 0 when asks_reagreement is false; it can be more if nothing was live, because the new version then inherits the newest version's requirement). A call with no new text and asks_reagreement false is refused: there is nothing to save. Nobody is emailed either way, and being out of date never blocks anything.",
      params: [
        {
          name: "title",
          required: false,
          description: "The new title. Send with body_md, or neither.",
        },
        {
          name: "body_md",
          required: false,
          description:
            "The new text, in the markdown subset get_code_of_conduct describes. Send with title, or neither.",
        },
        {
          name: "asks_reagreement",
          required: false,
          description:
            "true to ask everybody who agreed to an earlier version to agree again. Default false.",
        },
        {
          name: "base_version",
          required: false,
          description: "Which version an omitted field is carried over from. Default the live one.",
        },
        {
          name: "client_submission_id",
          required: false,
          description:
            "A UUID you choose. Resend the same one on a retry: a save that already landed comes back with already_saved true instead of writing a second version.",
        },
      ],
    },
    {
      name: "publish_code_of_conduct",
      method: "POST",
      summary:
        "Make an existing version the live one, e.g. to roll back. published false means it was already live and nothing changed. The reply's required_version says who is out of date afterwards: rolling back below a version that asked everybody to agree again undoes that ask. Its reprompted is how many people the publish put out of date, counted before it (a failed count is 500 db_error and publishes nothing).",
      params: [
        { name: "version", required: true, description: "The version number to make live." },
      ],
    },
    {
      name: "list_membership_plans",
      method: "POST",
      summary:
        "List every plan the club sells (trial, casual, each dated training period, yearly insurance), sorted for display. A dated plan (starts_on/ends_on both set) runs exactly those dates for anyone who buys it, full price regardless of when in it they join — there is no pro rata. A rolling plan (duration_days set, e.g. yearly insurance) runs that many days from payment. Neither set means the plan ends with its session credits instead of a date (trial, casual class). Includes inactive (retired) plans.",
      params: [],
    },
    {
      name: "save_membership_plan",
      method: "POST",
      summary:
        "Create or update a membership plan, and optionally email every member about it. Pass id to update an existing plan in place; omit it to create a new one. A plan may set starts_on/ends_on (a fixed date range) OR duration_days (a rolling window from payment) but never both — sending both is refused. Setting up a new training period is a new plan with its own price and dates, not a second date range on an existing one. NOTE: if the latest dated plan ends within 30 days and nothing is defined after it, the manager dashboard notifies managers — set the next one before then.",
      params: [
        {
          name: "id",
          required: false,
          description: "The plan's UUID, to update it. Omit to create a new plan.",
        },
        {
          name: "code",
          required: true,
          description:
            "Stable key, e.g. 'semester_2_2027'. Lowercase letters, digits and underscores only.",
        },
        { name: "name", required: true, description: "What members see, e.g. 'Semester 2 2027'." },
        { name: "description", required: false, description: "Shown under the plan's name." },
        {
          name: "kind",
          required: true,
          description: "insurance | trial | session | period.",
        },
        {
          name: "public_price_cents",
          required: true,
          description: "The general-public price, in integer cents.",
        },
        {
          name: "student_price_cents",
          required: false,
          description: "The UTS student price, in integer cents. Null/omit for no student rate.",
        },
        {
          name: "duration_days",
          required: false,
          description:
            "Rolling window: this many days from payment (e.g. 365 for yearly insurance). Mutually exclusive with starts_on/ends_on.",
        },
        {
          name: "session_credits",
          required: false,
          description: "Classes this plan grants (e.g. 2 for the free trial). Null for no credits.",
        },
        {
          name: "is_active",
          required: true,
          description: "Whether members can currently buy this plan.",
        },
        {
          name: "sort_order",
          required: true,
          description: "Lower sorts first on the member purchase screen.",
        },
        {
          name: "starts_on",
          required: false,
          description:
            "YYYY-MM-DD, the first day of training. Requires ends_on. Mutually exclusive with duration_days.",
        },
        {
          name: "ends_on",
          required: false,
          description:
            "YYYY-MM-DD, the LAST day of training (inclusive) — must be on or after starts_on. A membership bought for this plan covers this whole day.",
        },
        {
          name: "announce",
          required: false,
          description:
            "true to email every member about this plan once it is saved: everyone with an approved waiver, one email per family (to the parent, naming the children), with the plan's dates, price and a link to buy it. Sent immediately, and nobody can turn it off. IRREVERSIBLE and outward-facing: confirm with the manager first, saying how many people it reaches. Requires announcement_id.",
        },
        {
          name: "announcement_id",
          required: false,
          description:
            "A UUID you mint for this announcement, required with announce: true. Reuse it to retry or to finish sending (response announcement.pending > 0); the same id never emails anyone twice. A new id announces the plan again.",
        },
      ],
    },
    {
      name: "list_kb_sections",
      method: "POST",
      summary:
        "List the knowledge base's sections in sidebar order. Sections are the groups a member reads through (Start here, Belts and grading, ...), and their order plus each article's position IS the onboarding path: the sidebar, the index page and the previous/next links all come from it.",
      params: [],
    },
    {
      name: "save_kb_section",
      method: "POST",
      summary:
        "Create a section, rename it, or move it in the sidebar. An unknown slug creates it. An omitted field is left alone, so moving a section cannot rename it by accident.",
      params: [
        {
          name: "slug",
          required: true,
          description:
            "URL key: lowercase letters, numbers and single hyphens (start-here). A new slug creates a new section.",
        },
        {
          name: "title",
          required: false,
          description: "The heading members see. Required when creating a section.",
        },
        {
          name: "position",
          required: false,
          description:
            "Lower sorts first. The seeded sections use 10, 20, 30 so a new one can be slotted between two others without renumbering anything.",
        },
      ],
    },
    {
      name: "delete_kb_section",
      method: "POST",
      summary:
        "Delete a section. Its articles are NOT deleted: they fall into the 'Everything else' group at the bottom of the sidebar, where a member can still find them, so this tidies the navigation rather than removing anything anyone reads. Reports how many articles it displaced.",
      params: [
        { name: "slug", required: true, description: "The section's URL key, e.g. start-here." },
      ],
    },
    {
      name: "list_kb_articles",
      method: "POST",
      summary:
        "List the knowledge base's articles (versioned markdown pages served at /kb/<slug>) with their live version, section, position, visibility and whether they are taking comments. An entry with a link_path is not an article but a sidebar LINK to a page elsewhere on the site, and it has no versions.",
      params: [],
    },
    {
      name: "get_kb_article",
      method: "POST",
      summary:
        "Read one article's full markdown. Returns the live version unless you name one. Read this before saving an edit: save_kb_article replaces the whole body, so an edit built without reading first silently drops everything it did not include. The result also carries `sections`, every heading in it with the `url` that links straight to that heading — read the article you are about to point at and copy the url, rather than guessing the anchor.",
      params: [
        { name: "slug", required: true, description: "The article's URL key, e.g. our-history." },
        {
          name: "version",
          required: false,
          description: "Read a specific version instead of the live one.",
        },
      ],
    },
    {
      name: "save_kb_article",
      method: "POST",
      summary:
        "Create or update an article, or place it in the sidebar. Title + body_md write a NEW version and publish it — the body is replaced wholesale, never patched. Past versions are kept, and comments stay attached to the version they were written against, so readers whose comments predate this edit are shown that the wording moved on. Omit title and body_md to change only where the article sits, with no republish.",
      params: [
        {
          name: "slug",
          required: true,
          description:
            "URL key: lowercase letters, numbers and single hyphens (our-history). A new slug creates a new article, so a typo makes a second one at a second URL.",
        },
        {
          name: "title",
          required: false,
          description:
            "Shown as the page heading. Required with body_md when writing text; omit both to edit only the placement.",
        },
        {
          name: "body_md",
          required: false,
          description:
            "The whole article as markdown, up to 200000 characters. This REPLACES the previous body. Link to another article with an ordinary markdown link (/kb/<slug>), and to a SECTION of one by adding its anchor (/kb/belts#how-grading-works) — read that article with get_kb_article and take the anchor from its `sections`, rather than deriving it. Pin a heading's own anchor by ending it with the attribute syntax `## How grading works {#grading}`, so the link keeps working if the heading is reworded; the suffix is not shown to readers.",
        },
        {
          name: "section",
          required: false,
          description:
            "Slug of the section it belongs to. An unknown slug is refused rather than dropping the article out of the sidebar; send an empty string to move it into 'Everything else'. Omit to leave it where it is.",
        },
        {
          name: "position",
          required: false,
          description:
            "Lower sorts first within the section. This is the reading order a new member follows, so the first article of the first section is what 'start here' points at.",
        },
        {
          name: "nav_title",
          required: false,
          description:
            "A shorter label for the sidebar, when the title is long. Defaults to the title.",
        },
        {
          name: "link_path",
          required: false,
          description:
            "Makes this entry a LINK to a page elsewhere on this site (e.g. /first-class) instead of an article. Site-relative paths only, and it needs a nav_title since there is no article text to take a name from. Cannot be combined with title/body_md.",
        },
        {
          name: "visibility",
          required: false,
          description:
            "members | managers. Omit to leave it as it is; a new article defaults to members. 'managers' is the one to use for a draft. There is no public level: the whole knowledge base needs a login, so an article is either for the members or for the managers alone.",
        },
        {
          name: "annotations_enabled",
          required: false,
          description:
            "Whether readers may comment. Omit to leave it as it is; new articles accept comments and link entries never do.",
        },
        {
          name: "change_note",
          required: false,
          description:
            "What changed, in your own words. Shown to readers whose comments were written against an earlier version.",
        },
        {
          name: "expect_new",
          required: false,
          description:
            "Set true when you believe the slug is free. The save is refused if it is not, instead of quietly adding a version to somebody else's document and patching its visibility to yours. Use it whenever you are creating rather than editing.",
        },
      ],
    },
    {
      name: "list_kb_comments",
      method: "POST",
      summary:
        "Read the SHARED comments on an article — what members said, in threads, with the passage each was about. Private notes are never returned: they are private from the club too, by design, so this is not a complete view of everything readers wrote.",
      params: [
        { name: "slug", required: true, description: "The article's URL key." },
        {
          name: "version",
          required: false,
          description: "Only comments written against this version.",
        },
        {
          name: "include_resolved",
          required: false,
          description: "Include resolved threads. Default false.",
        },
        {
          name: "limit",
          required: false,
          description: "Max comments to return (1-500, default 200).",
        },
      ],
    },
    {
      name: "list_items",
      method: "POST",
      summary:
        "List the club's price list for things that are not a membership (a gi, a patch, a grading fee): each item's id, name and price_cents, alphabetically. These are what create_item_invoice charges for.",
      params: [],
    },
    {
      name: "save_item",
      method: "POST",
      summary:
        "Add an item to the price list (omit id) or rename / reprice one (pass id). A new price applies only to invoices raised from now on: every invoice already raised keeps its own copy of the name and price it was raised with. 404 not_found when id names no item.",
      params: [
        {
          name: "id",
          required: false,
          description: "The item's UUID, to change it. Omit to add one.",
        },
        { name: "name", required: true, description: "What it is called, up to 80 characters." },
        {
          name: "price_cents",
          required: true,
          description: "Its price in integer cents, from 1 to 1000000 ($10,000).",
        },
      ],
    },
    {
      name: "delete_item",
      method: "POST",
      summary:
        "Remove an item from the price list. Always safe: invoices already raised carry their own copy of every line, so nothing that has been sent changes. 404 not_found when it is already gone.",
      params: [{ name: "id", required: true, description: "The item's UUID." }],
    },
    {
      name: "list_item_invoices",
      method: "POST",
      summary:
        "List item invoices, newest first (at most 500): everyone's or one person's, optionally in one state. Each carries its reference (INV0007), lines (name, unit_price_cents, quantity), summary, total_cents, state (unpaid | paid | cancelled), paid_at and paid_reference (what a payment recorded by hand was known by), and who it is for (member_name, member_email). For a child, member_email is the guardian's and member_email_belongs_to names them: print the two together or not at all.",
      params: [
        { name: "user_id", required: false, description: "Only this person's invoices." },
        { name: "state", required: false, description: "unpaid | paid | cancelled." },
      ],
    },
    {
      name: "create_item_invoice",
      method: "POST",
      summary:
        "Raise an invoice for one or more items against a person and EMAIL it to them straight away (to the guardian, for a child), with the club's bank details and the invoice's own reference. An email cannot be unsent, so confirm the person and the items first. Each line names an item by id with a quantity; the price is read off the price list at this moment and a price sent with a line is refused. The same item twice is refused: set its quantity. Returns id, reference, total_cents, summary, emailed (false when the send failed: the invoice still exists and is on their membership page) and already_raised (with summary describing the invoice that DID land, which may differ from what this call asked for). 404 not_found for an unknown person; 422 item_not_listed when an item has been removed from the list; 409 submission_conflict when the client_submission_id was already used for somebody else.",
      params: [
        { name: "user_id", required: true, description: "The person's UUID, from list_users." },
        {
          name: "lines",
          required: true,
          description:
            "1 to 20 of { item_id, quantity }: item_id from list_items, quantity 1 to 99.",
        },
        {
          name: "client_submission_id",
          required: false,
          description:
            "A UUID you mint per invoice and resend unchanged on a retry. A retry of a raise that already landed returns that invoice with already_raised true and emails nothing. Without it, a retry after a lost reply raises and emails a second invoice.",
        },
      ],
    },
    {
      name: "mark_item_invoice_paid",
      method: "POST",
      summary:
        "Record a payment against an item invoice, for money that never touches the club account (cash at the door). Bank reconciliation does this itself when a statement line carries the reference and the exact total, so reach for this only when it cannot. Emails a receipt, and makes the invoice permanent: a paid invoice can never be cancelled or deleted. Idempotent: a second call records nothing and sends nothing (recorded: false). 409 item_invoice_settled on a cancelled invoice. paid_on and paid_reference record when the money arrived and what it was known by.",
      params: [
        { name: "id", required: true, description: "The item invoice's UUID." },
        {
          name: "payment_method",
          required: false,
          description:
            "bank_transfer | manual. Defaults to manual; say bank_transfer only for a real transfer you are recording by hand.",
        },
        {
          name: "paid_on",
          required: false,
          description:
            'YYYY-MM-DD, the day the money arrived, in the club\'s timezone. Defaults to today (also when sent as "" or null). A future day is refused, and so is one more than two years ago (a mistyped year); an earlier one, even before the invoice was raised, is accepted.',
        },
        {
          name: "paid_reference",
          required: false,
          description:
            "What the payment was known by, such as a receipt number or the transfer's own reference (up to 200 characters). Not the invoice's payment_reference, which this never changes.",
        },
      ],
    },
    {
      name: "cancel_item_invoice",
      method: "POST",
      summary:
        "Withdraw an unpaid item invoice and keep the record. It stops showing as owed on the member's page; nothing is emailed and it cannot be reopened (raise a new one instead). A second call on a cancelled invoice is a no-op. 409 item_invoice_settled when it has been paid.",
      params: [{ name: "id", required: true, description: "The item invoice's UUID." }],
    },
    {
      name: "delete_item_invoice",
      method: "POST",
      summary:
        "Remove an unpaid (or cancelled) item invoice outright, for one raised by mistake. Cannot be undone, and nothing tells the member, who may already have the email. 409 item_invoice_settled when it has been paid: a paid invoice is the club's record of money and is never deleted.",
      params: [{ name: "id", required: true, description: "The item invoice's UUID." }],
    },
    {
      name: "get_club_settings",
      method: "POST",
      summary:
        "Read the club-wide settings: email_reply_to (where a reply to any club email goes, or null when unset) and payment_details (the bank account members pay into, or null when not published). 503 settings_unreadable when they could not be read: that is not the same as nothing being set, so retry rather than treating it as empty.",
      params: [],
    },
    {
      name: "get_site_banner",
      method: "POST",
      summary:
        "Read the site banner, the one-line notice across the top of every public page: { banner: { enabled, message, link_label, link_href } }. Off (enabled: false) when nobody has set one; the message may still be there while it is off. 503 settings_unreadable when it could not be read, which is not the same as it being off.",
      params: [],
    },
    {
      name: "save_site_banner",
      method: "POST",
      summary:
        "Change the site banner. Public and immediate: every visitor sees it at the top of every public page from their next page load until they close it, and a changed message is shown again even to people who closed the old one. Send only the fields you are changing; the rest keep their stored values. Undone by saving again (enabled: false turns it off). 400 invalid_params when the result breaks a rule below; 409 outside_link when the stored link goes to another site and the call does more than switch the banner off; 503 settings_unreadable when the current banner could not be read, so nothing is merged over a guess. Returns the banner as saved.",
      params: [
        { name: "enabled", required: false, description: "true shows the banner, false hides it." },
        {
          name: "message",
          required: false,
          description:
            "One line, up to 200 characters; line breaks become spaces. Required (non-empty) while enabled is true.",
        },
        {
          name: "link_label",
          required: false,
          description:
            "The underlined link text after the message, up to 60 characters. Empty for no link. Needs link_href.",
        },
        {
          name: "link_href",
          required: false,
          description:
            "Where the link goes: a page on this site, like /register-interest or /faq#trial (a full https://utsjitsu.com.au/... address counts). Empty for no link. Needs link_label. An outside address is refused here (400 invalid_params) and can only be set on the manager's Site banner screen. While the stored link goes to another site, the only change allowed here is enabled: false, or replacing link_href with a page on this site (409 outside_link otherwise).",
        },
      ],
    },
    {
      name: "resend_email",
      method: "POST",
      summary:
        "Send one email again to the person it went to (the guardian, for a child), rebuilt from today's records rather than replayed: an invoice carries the amount owed now and the club's current bank details, a waiver confirmation a fresh PDF link, a verification email a fresh link. Managers are not copied. Once a minute per email per record (429 rate_limited, with Retry-After). 404 not_found; 409 paid | unpaid | cancelled | not_approved | locked | already_verified when the record has moved on (checked again at the send); 409 already_sent when this client_submission_id already sent it; 422 paper | no_address | dependant | free when nothing can be sent; 503 email_not_sent when it did not go out (retry with the same client_submission_id). Returns to and to_belongs_to: print the two together.",
      params: [
        {
          name: "kind",
          required: true,
          description:
            "membership_invoice | membership_receipt | item_invoice | item_invoice_receipt | waiver_confirmation | account_activated | email_verification.",
        },
        {
          name: "record_id",
          required: true,
          description:
            "The membership's id (membership_*), the item invoice's id (item_invoice*), the waiver's id (waiver_confirmation, account_activated), or the person's user_id (email_verification).",
        },
        {
          name: "client_submission_id",
          required: false,
          description:
            "A UUID for this resend. Reuse it to retry the same resend safely; omit it and every call is a new send.",
        },
      ],
    },
    {
      name: "list_blog_posts",
      method: "POST",
      summary:
        "List every blog post, drafts included, newest first: id, slug, title, status (draft | published), published_at, and two addresses. url is where the public reads it, and is null for a draft, which has no public address. edit_url is the manager's own screen for the post, which works whatever its status. No bodies: get_blog_post reads one.",
      params: [],
    },
    {
      name: "get_blog_post",
      method: "POST",
      summary:
        "Read one post, any status, in full: everything list_blog_posts reports plus excerpt, body_md (Markdown), cover_image_path and cover_image_url. Pass id, or the slug from the post's address (/blog/<slug>). 404 not_found when there is no such post.",
      params: [
        { name: "id", required: false, description: "The post's id. Send this or slug." },
        {
          name: "slug",
          required: false,
          description: "The last part of the post's address, /blog/<slug>. Send this or id.",
        },
      ],
    },
    {
      name: "save_blog_post",
      method: "POST",
      summary:
        "Create a post (no id) or change one (id). The same save as the manager's blog editor: a blank slug is made from the title and today's date, a blank excerpt is taken from the opening of the body, and published_at is set the first time a post goes live and never moves after that. On a change, every field you leave out keeps its stored value, so publishing a draft is {id, status: \"published\"} and fixing a typo is {id, body_md}. PUBLISHING IS PUBLIC AND ANNOUNCED: the first time a post goes live it is on the public blog at once, and every member who has opted in to announcements hears about it in their daily summary email. Taking it back to draft hides it again but cannot take the announcement back. Saving a post that is already live announces nothing. The result says whether this save announced it (announced), with the post's url and edit_url. 404 not_found for an id with no post. 409 slug_taken when a new post's address (the slug you sent, or the one made from today's date and the title) already belongs to a post, whose id and slug are in error.details: after a create you never heard back from, that is the post you made, so read it rather than creating again; for a genuinely different post, send a slug of your own. 409 post_changed when somebody saved the post after this change was read: nothing was written, so read it again and redo the change.",
      params: [
        {
          name: "id",
          required: false,
          description: "The post to change, from list_blog_posts. Omit to create a new post.",
        },
        {
          name: "title",
          required: false,
          description: "Up to 200 characters. Required for a new post.",
        },
        {
          name: "body_md",
          required: false,
          description:
            "The whole post as Markdown, up to 50000 characters. Required for a new post. It REPLACES the stored body, so read the post with get_blog_post first and edit what you get back. Images are ordinary Markdown images; put one in with the markdown that upload_blog_image returns. A line of its own reading [[video:<url>]] embeds a video: a YouTube link plays inline, any other link shows as a plain link.",
        },
        {
          name: "status",
          required: false,
          description:
            "draft | published. A new post is a draft unless you say otherwise. Omit on a change to leave it as it is. See the summary for what publishing does.",
        },
        {
          name: "slug",
          required: false,
          description:
            "The post's address, /blog/<slug>: lowercase letters, numbers and single hyphens. Omit on a new post to have one made from the date and title. Changing it on a live post moves the post to a new address and every link already shared to the old one stops working. A slug another post already has gets -2, -3 added rather than failing, so read the slug the result returns.",
        },
        {
          name: "excerpt",
          required: false,
          description:
            "The line under the title on the blog list, and the description search engines show. Up to 500 characters. An empty string takes it from the opening of the body. Omit on a change to keep the stored one, which does not follow a rewritten body by itself: send an empty string with the new body to have it taken afresh.",
        },
        {
          name: "cover_image_path",
          required: false,
          description:
            "The picture at the top of the post and on the blog list: the path that upload_blog_image returned, not its url. An empty string removes it.",
        },
      ],
    },
    {
      name: "delete_blog_post",
      method: "POST",
      summary:
        "Delete a post for good, with every comment on it. There is no undo and nothing keeps a copy. To take a post off the public blog and keep it, use save_blog_post with status draft instead. 404 not_found when there is no such post.",
      params: [{ name: "id", required: true, description: "The post's id, from list_blog_posts." }],
    },
    {
      name: "upload_blog_image",
      method: "POST",
      summary:
        "Store an image for a blog post: PNG, JPEG, WebP or GIF, up to 8 MB. Send the image as base64 data, or a public https url for the server to download (the practical route over MCP, where the bytes would have to be typed out). The format is read from the image itself, so a file that is not one of the four is refused whatever it is called. Returns path (give it to save_blog_post as cover_image_path), url (where it is served from) and markdown (paste it into body_md where the image belongs). Storing an image changes no post: it shows nowhere until a save puts it in one. 422 image_rejected when the image can never be used (not an image, too large, an address that is not public https, or one that answers not found or forbidden); 502 image_fetch_failed when the address could not be read just now (no answer, too slow, busy, or a server error), which may work on a later try.",
      params: [
        {
          name: "data",
          required: false,
          description: "The image as raw base64, no data: prefix. Send this or url.",
        },
        {
          name: "url",
          required: false,
          description:
            "A public https address to download it from: one that opens in a browser without signing in. Up to five redirects are followed. Send this or data.",
        },
        {
          name: "alt",
          required: false,
          description:
            "Words describing the image for somebody who cannot see it, used in the returned markdown. Defaults to the file name.",
        },
        {
          name: "name",
          required: false,
          description: "A file name to store it under. Defaults to the one in url, else image.",
        },
        {
          name: "post_id",
          required: false,
          description:
            "The post it is for, which only decides the folder it is filed in. Omit for a post not saved yet.",
        },
      ],
    },
    {
      name: "list_calendar_events",
      method: "POST",
      summary:
        "Every date on the club calendar from 30 days ago to 180 days ahead, oldest first: the list on the manager's Calendar screen, from the same read. One-offs and every date a weekly entry has generated, cancelled ones included. Each date has id (what the other calendar actions take), series_id and repeats (set when it is one week of a weekly entry; series_id is what stop_calendar_repeat takes), title, starts_at and ends_at (UTC), starts_local and ends_local (the same times in club time, Australia/Sydney, as YYYY-MM-DDTHH:MM, the shape create_calendar_entry takes), weekday (the club-time day it starts on), status (scheduled | cancelled), visibility (public | members, where members means paid members and managers only), invite_only (true when the date or the weekly entry it belongs to is invite only, which is what hides it), instructor_name, location, description, and rsvps { going, maybe, declined }. A weekly entry keeps between six and twelve weeks of dates listed (it is topped up once its furthest date is within six weeks), so a week more than six weeks out may not be listed yet: it is not missing, it cannot be edited or cancelled until it appears, and it is no reason to add a one-off for it. Who replied: list_calendar_rsvps. time_zone names the club's zone.",
      params: [],
    },
    {
      name: "list_calendar_rsvps",
      method: "POST",
      summary:
        "Who has replied to one date, newest reply first, as the manager's Calendar screen lists them: user_id, name, email, response (going | maybe | declined) and updated_at. Replies are made by people signed in to the site, so each email is that person's own. 404 not_found when there is no such date, so an empty list always means nobody has replied.",
      params: [
        {
          name: "event_id",
          required: true,
          description: "The date's id, from list_calendar_events.",
        },
      ],
    },
    {
      name: "create_calendar_entry",
      method: "POST",
      summary:
        "Put something on the calendar: the Add form on the manager's Calendar screen. It is on the calendar page (or only for paid members, with visibility members) and in every subscriber's calendar app straight away. Nobody is emailed. A one-off takes repeat {type: \"never\", starts_at, ends_at}; a weekly entry takes repeat {type: \"weekly\", weekday, start_time, duration_minutes, starts_on, ends_on} and its dates are generated about twelve weeks ahead, with more appearing as they get close. Returns repeats, event_id (the one-off's date; null for a weekly entry), series_id (the weekly entry; null for a one-off), generated (how many dates went on; 0 only for a weekly entry that starts more than about twelve weeks away, whose dates appear as it gets close) and dates, each as list_calendar_events reports it without rsvps: read the weekday and starts_local of the first back to the manager. Sending the same entry again is refused rather than doubled, so a create you never heard back from can be sent again: 409 already_on_calendar when the same title already starts at that time, as a one-off or one week of a repeat (a cancelled date there counts only if it also ends at the same time, so cancelling a date and adding a longer one-off in its place works), or already repeats on that weekday at that time on any of the same dates (next semester's run of a class is not a duplicate of this one). error.details names the match: event_id, series_id and status for a one-off, series_id for a weekly entry. 422 no_dates for a weekly entry that would put no date on the calendar at all: its last date has passed, or no date from starts_on to ends_on falls on that weekday. A cancelled match says so: restore it with cancel_calendar_entry rather than adding it again, or give a genuinely different entry a different title.",
      params: [
        {
          name: "title",
          required: true,
          description:
            'Up to 120 characters, and the only detail the calendar needs: "Beginner Gi", "Grading", "End of semester social".',
        },
        {
          name: "repeat",
          required: true,
          description:
            'An object. A one-off: {"type":"never","starts_at":"2026-11-05T18:00","ends_at":"2026-11-05T19:30"}. A time with no offset is club time (Australia/Sydney), read the way the screen reads its pickers, and is the one to send: an ISO time with an offset or Z is accepted too, but Sydney moves between +10:00 and +11:00 in April and October. It must end at or after it starts. Weekly: {"type":"weekly","weekday":1,"start_time":"18:00","duration_minutes":90,"starts_on":"2026-11-02","ends_on":"2026-12-14"}, where weekday is 0 Sunday, 1 Monday, 2 Tuesday, 3 Wednesday, 4 Thursday, 5 Friday or 6 Saturday; start_time is club time, 24-hour HH:MM; duration_minutes is 1 to 600; starts_on is the first date it may run and ends_on the last (YYYY-MM-DD; omit ends_on, or send null, to keep it repeating). A weekly entry\'s day, time and length cannot be changed later: stop it and add it again.',
        },
        {
          name: "instructor_name",
          required: false,
          description: "Up to 80 characters. Blank is normal for socials and gradings.",
        },
        {
          name: "location",
          required: false,
          description:
            "Up to 120 characters. Leave it out for the club's gym (ActivateFit Gym, UTS Building 4, 745 Harris Street, Ultimo NSW 2007), which the screen's form fills in; send an empty string for no location at all.",
        },
        {
          name: "description",
          required: false,
          description: "Free text, up to 4000 characters.",
        },
        {
          name: "visibility",
          required: false,
          description:
            "public (the default): everybody, on the public calendar page. members: paid members and managers only, on the site and in calendar links. Enforced, not a label.",
        },
        {
          name: "invite_only",
          required: false,
          description:
            "true shows each date only to the people invited to it (those with a reply on it) and to managers; everybody else never sees it. Default false. There is no action that invites anybody.",
        },
      ],
    },
    {
      name: "edit_calendar_entry",
      method: "POST",
      summary:
        "Change an entry's details: Edit on the manager's Calendar screen. id is always a date from list_calendar_events. scope event changes that date only. scope series, only on a date of a weekly entry, changes that date and every later one, and the weekly rule, so dates still to be generated carry the change too; dates before the one you name are never rewritten, because they record what happened. Only the fields you send change. An empty string (or null) clears description, instructor_name or location; title cannot be cleared. A date's day, time and length cannot be changed: cancel it and add a one-off, or for a weekly entry stop it and add it again. Visible at once on the site and in subscribers' calendar apps; nobody is emailed. Who can see a date is its own invite_only or its weekly entry's: so invite_only true with scope series hides every date of the entry, earlier ones included, and scope event cannot make one date of an invite-only weekly entry visible again (only scope series with invite_only false can). Returns updated, the number of dates changed. 404 not_found when there is no such date; 422 not_repeating for scope series on a one-off; 400 invalid_params when no field to change was sent.",
      params: [
        {
          name: "scope",
          required: true,
          description:
            "event (this date only) | series (this date and every later one of its weekly entry).",
        },
        {
          name: "id",
          required: true,
          description:
            "The date's id, from list_calendar_events. With scope series, the first date to change.",
        },
        {
          name: "title",
          required: false,
          description: "Up to 120 characters.",
        },
        {
          name: "instructor_name",
          required: false,
          description: "Up to 80 characters. Empty string or null to clear.",
        },
        {
          name: "location",
          required: false,
          description: "Up to 120 characters. Empty string or null to clear.",
        },
        {
          name: "description",
          required: false,
          description: "Up to 4000 characters. Empty string or null to clear.",
        },
        {
          name: "visibility",
          required: false,
          description: "public | members, as for create_calendar_entry.",
        },
        {
          name: "invite_only",
          required: false,
          description: "true | false, as for create_calendar_entry.",
        },
      ],
    },
    {
      name: "cancel_calendar_entry",
      method: "POST",
      summary:
        "Cancel a date, or restore one with cancelled: false: Cancel and Restore on the manager's Calendar screen. A cancelled date stays on the calendar, struck through and marked Cancelled, its replies are kept, and subscribed calendar apps show it as cancelled. Nobody is emailed, and a cancelled date cannot be replied to or checked in to. scope event is that date only; scope series, only on a date of a weekly entry, is that date and every later one already on the calendar. Weeks the entry generates later are not cancelled, so to end a weekly entry for good use stop_calendar_repeat. Returns updated, the number of dates changed. 404 not_found when there is no such date; 422 not_repeating for scope series on a one-off.",
      params: [
        {
          name: "id",
          required: true,
          description:
            "The date's id, from list_calendar_events. With scope series, the first date to change.",
        },
        {
          name: "cancelled",
          required: true,
          description: "true to cancel, false to restore.",
        },
        {
          name: "scope",
          required: false,
          description:
            "event (the default, this date only) | series (this date and every later one already on the calendar).",
        },
      ],
    },
    {
      name: "stop_calendar_repeat",
      method: "POST",
      summary:
        "Stop a weekly entry repeating: Stop repeating on the manager's Calendar screen. Every date still to start is taken off the calendar and no more are made. Dates that have started stay, because they happened, and so does a date still to start that somebody is already checked in to (its id is in kept_checked_in). There is no undo: to have it again, add it again with create_calendar_entry. Nobody is emailed. Safe to send again: a repeat already stopped is left as it is, apart from clearing any date a first call missed, and comes back already_stopped: true. Returns removed (how many dates came off), kept_checked_in and already_stopped. 404 not_found when there is no such weekly entry.",
      params: [
        {
          name: "series_id",
          required: true,
          description:
            "The weekly entry's series_id, from any of its dates in list_calendar_events.",
        },
      ],
    },
    {
      name: "delete_calendar_entry",
      method: "POST",
      summary:
        "Delete a one-off date outright, for a mistake: it goes from the calendar as though it was never there, with every reply to it, and there is no undo. To call something off, cancel_calendar_entry is almost always what is wanted, since it keeps the record. 409 repeating_date for a date of a weekly entry, which cannot be deleted on its own (series_id in error.details; cancel the date, or stop_calendar_repeat); 409 checked_in when people were checked in to it (checked_in, the number, in error.details), since deleting it would take their sessions with it; 404 not_found when there is no such date.",
      params: [
        {
          name: "id",
          required: true,
          description: "The date's id, from list_calendar_events.",
        },
      ],
    },
  ],
};

/**
 * Classify a raw request body's `action` field before dispatch, distinguishing
 * an absent field from a present-but-invalid one — otherwise both report
 * "unknown_action" and a caller who built the body wrong (forgot the field
 * entirely) reads the same message as one who typo'd the action name.
 */
export function classifyAction(
  action: unknown,
  validActions: readonly string[],
):
  | { ok: true; action: string }
  | { ok: false; code: "missing_action" | "unknown_action"; message: string } {
  if (action === undefined || action === null) {
    return { ok: false, code: "missing_action", message: "Missing required field: action." };
  }
  if (typeof action !== "string" || !validActions.includes(action)) {
    return {
      ok: false,
      code: "unknown_action",
      message: `Unknown action. Valid actions: ${validActions.join(", ")}.`,
    };
  }
  return { ok: true, action };
}

/**
 * A dispatch/auth failure carrying the HTTP status + a stable machine code.
 *
 * `details` is merged into the response's `error` object for the failures where
 * a message alone leaves the caller stuck: a blocked duplicate names the waivers
 * it collided with, a blocked reconciled edit names the fields it refused.
 */
export class AgentError extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;
  /** Emitted as a `Retry-After` header, for failures a client should repeat. */
  retryAfterSeconds?: number;
  constructor(
    httpStatus: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Constant-time string comparison for the API token: never early-exits on the
 * first differing byte, so it doesn't leak the token's length prefix by timing.
 * (The length itself is compared first — acceptable for a random opaque key.)
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull the token out of an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * The membership columns `edit_invoice` may write (documented in the manifest).
 *
 * `starts_at` / `ends_at` are here for the diff and the audit trail, not as
 * fields a caller names: the API takes a `starts_on` DAY and resolves the pair
 * itself, so the two always move together and a window can never be hand-built
 * into a shape no plan sells.
 */
export const INVOICE_EDITABLE_FIELDS = [
  "price_cents",
  "notes",
  "payment_reference",
  "payment_method",
  "status",
  "starts_at",
  "ends_at",
] as const;

/**
 * Turn a validated edit_invoice input into a DB patch containing only the fields
 * the caller actually supplied (so unspecified columns are never overwritten).
 *
 * Takes a Partial rather than a whole `EditInvoiceInput`: this reads the named
 * editable fields and nothing else, so requiring `id` or the `confirm_paid_edit`
 * flag in the signature would only be asking callers for values it ignores.
 *
 * `window` is the resolved answer to the input's `starts_on` — the caller works
 * it out from the plan (which decides whether that plan has a start date to set
 * at all) and hands the pair in, so this stays a pure field-by-field copy.
 */
export function buildInvoicePatch(
  input: Partial<EditInvoiceInput>,
  window?: { starts_at: string; ends_at: string | null },
): Partial<MembershipRow> {
  const patch: Partial<MembershipRow> = {};
  if (input.price_cents !== undefined) patch.price_cents = input.price_cents;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.payment_reference !== undefined) patch.payment_reference = input.payment_reference;
  if (input.payment_method !== undefined) patch.payment_method = input.payment_method;
  if (input.status !== undefined) patch.status = input.status;
  if (window) {
    patch.starts_at = window.starts_at;
    patch.ends_at = window.ends_at;
  }
  return patch;
}

export type InvoiceEditableField = (typeof INVOICE_EDITABLE_FIELDS)[number];

/**
 * The subset of editable fields that record money which actually moved through
 * the bank. Once an invoice is paid, these are not "details" any more: they are
 * the club's account of a real transaction, and rewriting one silently makes
 * the books and the bank disagree with nothing to show what changed. Guarded on
 * a paid invoice — still editable, but only when the caller says so.
 *
 * `status` is deliberately NOT here. Expiring or cancelling a membership that
 * ran its course is an ordinary lifecycle move, not a rewrite of the payment,
 * and the one status that has consequences ("active") is already refused by the
 * schema. `notes` is free text about the invoice, never a claim about money.
 *
 * Nor are `starts_at` / `ends_at`. They say when somebody is covered, not what
 * they paid, and the case for correcting them is at its strongest AFTER the
 * money landed: a year of insurance settled in March, recorded in April, and
 * dated from the day the manager got to it. Guarding them would refuse the very
 * edit they exist for.
 */
export const RECONCILED_GUARDED_FIELDS: readonly InvoiceEditableField[] = [
  "price_cents",
  "payment_reference",
  "payment_method",
];

/**
 * The editable columns holding a timestamp, where one instant has more than one
 * spelling. See `sameInstant`.
 */
const INSTANT_FIELDS = new Set<InvoiceEditableField>(["starts_at", "ends_at"]);

/** A field value as a timestamp, or null when it is not a string to parse. */
function asInstant(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** What an edit would actually change, and what those fields hold right now. */
export type InvoiceEditDiff = {
  /** Editable fields whose value would genuinely move (a no-op edit is empty). */
  changed: InvoiceEditableField[];
  /** The pre-edit value of each changed field, keyed by field name. */
  previous: Partial<Record<InvoiceEditableField, unknown>>;
};

/**
 * Compare a patch against the row it is about to be written over. Submitting a
 * field with the value it already holds is not a change, so it neither trips the
 * reconciled guard nor shows up in the audit trail as an edit that happened.
 */
export function diffInvoicePatch(
  existing: Partial<Record<InvoiceEditableField, unknown>>,
  patch: Partial<Record<InvoiceEditableField, unknown>>,
): InvoiceEditDiff {
  const changed: InvoiceEditableField[] = [];
  const previous: Partial<Record<InvoiceEditableField, unknown>> = {};
  for (const field of INVOICE_EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const before = existing[field] ?? null;
    const after = patch[field] ?? null;
    if (before === after) continue;
    // The two date columns are the only ones where equal values can be spelled
    // differently: the row was read back from Postgres as `+00:00` and the patch
    // was written by JS as `Z`. A string compare would call every resubmitted
    // start date a change, putting a move that never happened into the club's
    // only record of who edited an invoice.
    if (INSTANT_FIELDS.has(field) && sameInstant(asInstant(before), asInstant(after))) continue;
    changed.push(field);
    previous[field] = before;
  }
  return { changed, previous };
}

/**
 * Which of an edit's changed fields the reconciled guard refuses. Empty for an
 * unpaid invoice (nothing has been reconciled yet), for an edit that only
 * touches unguarded fields, and when the caller has confirmed.
 */
export function reconciledEditBlockers(
  invoice: { paid_at: string | null },
  changed: readonly InvoiceEditableField[],
  confirmed: boolean | undefined,
): InvoiceEditableField[] {
  if (!invoice.paid_at || confirmed) return [];
  return changed.filter((f) => RECONCILED_GUARDED_FIELDS.includes(f));
}

/** The message a caller gets when the reconciled guard refuses their edit. */
export function reconciledEditMessage(blocked: readonly string[], paidAt: string): string {
  return (
    `This invoice was paid on ${paidAt}, so ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} a record of money that already moved. ` +
    "Send the edit again with confirm_paid_edit set to true if you mean to correct it anyway."
  );
}

/**
 * The audit record of an invoice edit: who changed what, from what, to what.
 * Written to the server log (there is no audit table) so a disagreement between
 * the books and the bank can be reconstructed rather than guessed at. Pure and
 * returned rather than logged here, so the shape is pinned by a test.
 */
export function invoiceEditAudit(opts: {
  invoiceId: string;
  actor: string;
  paidAt: string | null;
  confirmed: boolean | undefined;
  diff: InvoiceEditDiff;
  patch: Partial<Record<InvoiceEditableField, unknown>>;
  at: string;
}) {
  return {
    event: "invoice_edited",
    invoice_id: opts.invoiceId,
    actor: opts.actor,
    at: opts.at,
    reconciled: Boolean(opts.paidAt),
    // True only when the flag actually let a guarded field through. A caller
    // that sets confirm_paid_edit defensively on every call, then edits only
    // notes, has overridden nothing — and logging that as an override would put
    // false "someone rewrote the money record" entries in the very log the club
    // would reach for to reconstruct a books-versus-bank disagreement.
    overridden:
      Boolean(opts.paidAt) &&
      opts.confirmed === true &&
      opts.diff.changed.some((f) => RECONCILED_GUARDED_FIELDS.includes(f)),
    changes: opts.diff.changed.map((field) => ({
      field,
      from: opts.diff.previous[field] ?? null,
      to: opts.patch[field] ?? null,
    })),
  };
}

/** Client-safe projection of an invoice (membership) joined with its plan. */
export function projectInvoice(m: MembershipRow, plan?: MembershipPlanRow) {
  return {
    id: m.id,
    user_id: m.user_id,
    plan_code: plan?.code ?? null,
    plan_name: plan?.name ?? null,
    status: m.status,
    price_cents: m.price_cents,
    price: formatCents(m.price_cents),
    payment_reference: m.payment_reference,
    payment_method: m.payment_method,
    is_student: m.is_student,
    paid_at: m.paid_at,
    paid_reference: m.paid_reference,
    starts_at: m.starts_at,
    ends_at: m.ends_at,
    // The plan's session allowance and this invoice's own remaining balance —
    // set at activation (`activateMembershipRow`) and spent one-per-check-in
    // (see `checkin.functions.ts`). Deliberately per-invoice, not lifetime:
    // unlike `sessions_attended` on list_users (which counts all-time classes),
    // this is scoped to what THIS plan grants, so it answers "how much of this
    // trial/pack is left".
    // sessions_allowed is null only when the plan carries no session credits
    // (e.g. a period plan). sessions_remaining is ALSO null for a still-`pending`
    // invoice on a session-credit plan (e.g. a paid `casual_session` awaiting
    // bank transfer) — activation is what populates it, so null there means "not
    // started yet", not "no allowance". Read status/paid_at alongside it rather
    // than treating null as zero.
    sessions_allowed: plan?.session_credits ?? null,
    sessions_remaining: m.sessions_remaining,
    notes: m.notes,
    created_at: m.created_at,
  };
}
