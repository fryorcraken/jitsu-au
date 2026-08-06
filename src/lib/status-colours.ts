// Every status colour the club shows, in one place.
//
// The same statuses appear on `/manager/users`, a person's manager page,
// `/manager/memberships`, `/manager/waivers` and a member's own `/membership`
// screen. Managers move between those screens constantly, so a status has to
// look the same on all of them.
//
// When these maps lived in each route they drifted, which is what this module
// exists to stop: "pending" was grey on the waivers list and amber on the
// person page, and the role and lifecycle pills capitalised their label on one
// screen but not the other.
//
// Pure data with no imports beyond types, so it stays unit-testable and can be
// read by a server-rendered route as happily as by a component. The badge that
// wears these classes is `@/components/site/StatusPill`.
import type { VerificationLabel } from "./email-verification";
import type {
  BlogCommentStatus,
  BlogPostStatus,
  CoverageSource,
  LifecycleStatus,
  MembershipStatus,
  WaiverListStatus,
} from "./validation";

/** Used for a status no map knows. Reads as "no signal", never as an alarm. */
export const NEUTRAL_STATUS_CLASS = "bg-slate-100 text-slate-800";

// Each map is keyed by its status union, so adding a lifecycle phase or a
// membership state fails to compile until it has been given a colour.
const LIFECYCLE: Record<LifecycleStatus, string> = {
  lead: NEUTRAL_STATUS_CLASS,
  applicant: "bg-amber-100 text-amber-800",
  visitor: "bg-sky-100 text-sky-800",
  member: "bg-green-100 text-green-800",
  lapsed: "bg-red-100 text-red-800",
};

const MEMBERSHIP: Record<MembershipStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  expired: "bg-red-100 text-red-800",
  cancelled: NEUTRAL_STATUS_CLASS,
};

// Verified means someone opened a link we sent to that address. Amber rather
// than red: an unverified address is a thing to notice before emailing someone
// a sign-in link, not a fault.
const VERIFICATION: Record<VerificationLabel, string> = {
  verified: "bg-green-100 text-green-800",
  unverified: "bg-amber-100 text-amber-800",
};

// Waiver statuses keep the theme tokens rather than joining the amber/green
// family. That vocabulary is older than the others and both waiver screens
// already agree on it, so matching it was the fix; changing it would be a
// design decision, not a de-duplication.
const WAIVER: Record<WaiverListStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  active: "bg-primary/15 text-primary",
  superseded: "bg-muted text-muted-foreground line-through",
};

// What paid for a class on the check-in board. Red is right for "none" here,
// unlike elsewhere: it is the one state a manager has to act on before the
// person steps on the mat.
const COVERAGE: Record<CoverageSource, string> = {
  trial: "bg-sky-100 text-sky-800",
  session: "bg-indigo-100 text-indigo-800",
  period: "bg-green-100 text-green-800",
  none: "bg-red-100 text-red-800",
};

// A blog post's authoring state, and a comment's moderation state. Separate
// vocabularies (a draft is neutral, not a fault; a hidden comment is the one
// that should read as acted-on, in red).
const BLOG_POST: Record<BlogPostStatus, string> = {
  draft: NEUTRAL_STATUS_CLASS,
  published: "bg-green-100 text-green-800",
};

const BLOG_COMMENT: Record<BlogCommentStatus, string> = {
  visible: "bg-green-100 text-green-800",
  hidden: "bg-red-100 text-red-800",
};

/** A role assignment (`member`, `manager`). One colour covers every role. */
export const ROLE_CLASS = "bg-indigo-100 text-indigo-800";

/** Colour for a lifecycle phase (`lead` … `lapsed`). */
export function lifecycleClass(status: string): string {
  return LIFECYCLE[status as LifecycleStatus] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for an enrollment's state (`pending` … `cancelled`). */
export function membershipClass(status: string): string {
  return MEMBERSHIP[status as MembershipStatus] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for the email badge (`verified` / `unverified`). */
export function verificationClass(label: string): string {
  return VERIFICATION[label as VerificationLabel] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for a waiver's derived status (`pending` / `active` / `superseded`). */
export function waiverClass(status: string): string {
  return WAIVER[status as WaiverListStatus] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for what covers a check-in (`trial` / `session` / `period` / `none`). */
export function coverageClass(source: string): string {
  return COVERAGE[source as CoverageSource] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for a blog post's authoring state (`draft` / `published`). */
export function blogPostClass(status: string): string {
  return BLOG_POST[status as BlogPostStatus] ?? NEUTRAL_STATUS_CLASS;
}

/** Colour for a blog comment's moderation state (`visible` / `hidden`). */
export function blogCommentClass(status: string): string {
  return BLOG_COMMENT[status as BlogCommentStatus] ?? NEUTRAL_STATUS_CLASS;
}

/**
 * Colour for media/promotional-photo consent (`true` / `false` / not asked).
 *
 * A withdrawal is red because publishing a photo of someone who said no is the
 * mistake this badge exists to prevent, and it should stop a manager reading
 * quickly. Not-asked is amber, not neutral: it is a gap to close, and treating
 * it as a quiet "no" is how people never get asked.
 */
export function mediaConsentClass(value: boolean | null | undefined): string {
  if (value === true) return "bg-green-100 text-green-800";
  if (value === false) return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}
