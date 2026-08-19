import { describe, it, expect } from "vitest";
import type { Database } from "./types";

/**
 * A contract between the app and the *live* database.
 *
 * `types.ts` is generated from the live Supabase schema, so it is the closest
 * thing the repo has to a mirror of what the database actually holds. A
 * migration file sitting in `supabase/migrations/` proves nothing: Lovable does
 * not apply hand-written migrations, and `waivers.approval_status` was missing
 * from production for a week while the migration adding it sat in the repo.
 *
 * ⚠️ **The protection here is entirely `tsc`'s** — the assertions below are
 * type-level, so they are checked by `bun run typecheck`, NOT by `bun run test`.
 * A `vitest` run cannot see a schema change at all (types are erased), so a
 * green test report says nothing on its own. This lives in a `.test.ts` file
 * only to sit beside the code it constrains.
 *
 * Note the lag: `types.ts` changes when Lovable regenerates it or when someone
 * hand-adds a verified column, so a live `DROP COLUMN` produces no error here
 * until then. This is a backstop, not a live check — that is what
 * `supabase/lint/check-migration-drift.py` is for.
 *
 * When you add a column the app reads or writes, add it here.
 */

type Tables = Database["public"]["Tables"];

/**
 * Fails to compile unless every key in `K` exists on row type `T`.
 *
 * Deliberately not `satisfies Partial<Row>` with a sample object: that catches a
 * removed column but silently accepts a *widened* one (a column going
 * `string` -> `string | null` still accepts `"pending"`), and it needs fixture
 * values that invite tautological runtime assertions.
 */
type RequireColumns<T, K extends keyof T> = K;

/**
 * Exact type equality. The doubled conditional is the standard trick for
 * comparing types *invariantly*: a plain `T[K] extends Expected` would accept a
 * narrowing, and would also silently pass when `T[K]` is `never`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Fails to compile unless its argument is exactly `true`.
 *
 * The constraint is what makes this bite. An unconstrained `type X = ... : never`
 * compiles happily — `never` is assignable to everything — so a naive
 * conditional-type assertion silently passes. This one errors on `false`.
 */
type Expect<T extends true> = T;

/**
 * Fails to compile when `K` IS a key of `T`. Use to assert that a dropped
 * column has not crept back into the generated types.
 */
type AssertAbsent<T, K> = K extends keyof T ? false : true;

// ---- membership_plans: period_basis stays dropped, duration_days came back ----
// `20260803120000_membership_windows_contract.sql` dropped both `duration_days`
// and `period_basis` when the `semester` plan ran on `club_semesters` instead.
// `20260804000000_membership_plans_own_dates.sql` re-added `duration_days`
// (see its header for why) as the rolling half of a plan's own window, so only
// `period_basis` stays asserted absent — see `_MembershipPlanOwnDatesColumns`
// below for the pin on the reinstated column.
export type _MembershipPlansNoPeriodBasis = Expect<
  AssertAbsent<Tables["membership_plans"]["Row"], "period_basis">
>;

// ---- waivers: the approval workflow (the columns the outage was about) ----
export type _WaiverApprovalColumns = RequireColumns<
  Tables["waivers"]["Row"],
  "approval_status" | "approved_at" | "approved_by"
>;
// Exactly `string`, not `string | null`: `deriveWaiverListStatuses` and
// `deriveLifecycleStatus` compare it directly, and the column is
// NOT NULL DEFAULT 'pending'. A nullable widening here would mean the NOT NULL
// was dropped live, and every status comparison would quietly start missing.
export type _WaiverApprovalStatusIsString = Expect<
  Equals<Tables["waivers"]["Row"]["approval_status"], string>
>;

// ---- waivers: the frozen-submission person fields ----
export type _WaiverSubmissionColumns = RequireColumns<
  Tables["waivers"]["Row"],
  | "first_name"
  | "middle_name"
  | "last_name"
  | "preferred_name"
  | "email"
  | "uts_student_number"
  | "sms_whatsapp_consent"
  // The media-consent tick, promoted out of the PDF so the club can answer
  // "can we photograph this person" without opening one.
  | "media_consent"
  | "signer_ip"
  | "signer_meta"
  | "user_id"
  // How the emergency contact is related. For a minor this is no longer the
  // guardian by definition: the two can be different people, so the guardian
  // carries their own contact details below.
  | "emergency_contact_relationship"
  | "guardian_name"
  | "guardian_relationship"
  | "guardian_address"
  | "guardian_phone"
  | "guardian_email"
>;

// ---- waiver_templates: the manager-editable acknowledgements ----
export type _TemplateColumns = RequireColumns<
  Tables["waiver_templates"]["Row"],
  "acknowledgements" | "body_md" | "created_at" | "id" | "is_current" | "title" | "version"
>;

// ---- profiles: the fields waiver approval copies across, plus the two the
// club's kit sizing lives in (which approval deliberately does NOT touch) ----
export type _ProfileColumns = RequireColumns<
  Tables["profiles"]["Row"],
  | "user_id"
  | "first_name"
  | "preferred_name"
  | "uts_student_number"
  | "sms_whatsapp_consent"
  // Live media consent, plus the provenance that tells a manager-recorded
  // withdrawal apart from one the member ticked when they signed.
  | "media_consent"
  | "media_consent_updated_at"
  | "media_consent_updated_by"
  | "emergency_contact_relationship"
  // The guardian of a minor member, promoted from their approved waiver.
  | "guardian_name"
  | "guardian_relationship"
  | "guardian_address"
  | "guardian_phone"
  | "guardian_email"
  | "gi_size"
  | "belt_size"
>;

// ---- interest_registrations: the consent flag the public form writes ----
export type _InterestColumns = RequireColumns<
  Tables["interest_registrations"]["Row"],
  "sms_whatsapp_consent"
>;

// ---- membership_plans: a plan's own window (dated XOR rolling XOR neither) ----
// `activateMembershipRow` resolves a plan's dates from these three columns
// alone (via `planMembershipWindow`), with no second table to fall back on —
// if one went missing, activation would fail rather than pick a wrong default.
export type _MembershipPlanOwnDatesColumns = RequireColumns<
  Tables["membership_plans"]["Row"],
  "starts_on" | "ends_on" | "duration_days"
>;

// ---- email_verification_tokens: proof that someone can read an address ----
export type _VerificationTokenColumns = RequireColumns<
  Tables["email_verification_tokens"]["Row"],
  "token_hash" | "token_prefix" | "email" | "purpose" | "expires_at" | "revoked_at" | "last_used_at"
>;

/**
 * `user_id` is NULLABLE here, and that is load-bearing rather than incidental.
 *
 * A token is minted for an interest registration before any person record
 * exists, so it binds to the ADDRESS and the proof is applied when they sign a
 * waiver. If a regeneration ever tightened this to `string`, the whole
 * lead-verified-before-signing journey would stop compiling, which is the point.
 */
export type _VerificationTokenUserIdIsNullable = Expect<
  Equals<Tables["email_verification_tokens"]["Row"]["user_id"], string | null>
>;

/**
 * Verified state is read from `auth.users` through this RPC. There is
 * deliberately no `email_verified` column on `profiles`: one store, nothing to
 * drift. If `email_confirmed_at` disappears from the RPC's shape, every badge
 * in the manager UI silently reads `undefined` (i.e. "unverified") — so pin the
 * COLUMN NAMES.
 *
 * Deliberately not the nullability. The generator cannot know it for a function:
 * a `RETURNS TABLE (...)` declares OUT parameters, which carry no `attnotnull`,
 * and a scalar function's declared type says nothing either, so every function
 * return here prints non-null whether or not it is. Pinning `string | null`
 * only pinned a hand-edit that the next regeneration erased. The app's real
 * shape lives in `src/lib/supabase-rpc.ts` instead, and is pinned there.
 *
 * `RequireColumns`, not an exact key match: adding a column to the RPC is a
 * legitimate additive change and must not redden `main`.
 */
export type _UserEmailsReturnsConfirmation = RequireColumns<
  Database["public"]["Functions"]["user_emails"]["Returns"][number],
  "user_id" | "email" | "email_confirmed_at"
>;

// ---- session_checkins: attendance and what paid for it ----
export type _CheckinColumns = RequireColumns<
  Tables["session_checkins"]["Row"],
  | "event_id"
  | "user_id"
  | "checked_in_at"
  | "checked_in_by"
  | "coverage"
  | "membership_id"
  | "consumed_credit"
  | "closed_membership"
  | "warnings"
>;

/**
 * Exactly `string`, not `string | null`: the column is NOT NULL DEFAULT 'none'
 * and every screen compares it directly (`coverage === "none"` is what puts a
 * check-in in the needs-attention list). A nullable widening here would mean the
 * NOT NULL was dropped live, and uncovered check-ins would quietly stop being
 * listed as needing attention.
 */
export type _CheckinCoverageIsString = Expect<
  Equals<Tables["session_checkins"]["Row"]["coverage"], string>
>;

/**
 * Both NOT NULL, and both load-bearing for undo: `consumed_credit` decides
 * whether a session is given back, `closed_membership` decides whether the
 * membership is reopened. A nullable third state would make undo guess.
 */
export type _CheckinFlagsAreBooleans = Expect<
  Equals<Tables["session_checkins"]["Row"]["consumed_credit"], boolean>
>;
export type _CheckinClosedFlagIsBoolean = Expect<
  Equals<Tables["session_checkins"]["Row"]["closed_membership"], boolean>
>;

// ---- code_of_conduct_acceptances: who agreed to the house rules ----
export type _CodeOfConductColumns = RequireColumns<
  Tables["code_of_conduct_acceptances"]["Row"],
  | "user_id"
  | "version"
  | "accepted_at"
  | "full_name"
  | "email"
  | "signature_name"
  | "signer_ip"
  | "signer_meta"
>;

/**
 * Exactly `number`, not `number | null`. Every screen compares this against
 * `CODE_OF_CONDUCT_VERSION` to decide whether somebody's agreement is current,
 * and a nullable widening would mean the NOT NULL was dropped live, quietly
 * turning "agreed to nothing in particular" into a valid acceptance.
 */
export type _CodeOfConductVersionIsNumber = Expect<
  Equals<Tables["code_of_conduct_acceptances"]["Row"]["version"], number>
>;

/**
 * NOT NULL, unlike `email_verification_tokens.user_id` above, and the contrast
 * is the design: a verification token binds to an ADDRESS because it may exist
 * before the person does, whereas the code of conduct is only ever signed by
 * somebody the club already holds. Signing it never creates a person.
 */
export type _CodeOfConductUserIdIsNotNull = Expect<
  Equals<Tables["code_of_conduct_acceptances"]["Row"]["user_id"], string>
>;

/**
 * The idempotency key that makes retrying a form submission safe.
 *
 * Every public form now retries hard through a bad connection, because the
 * failure that matters is a waiver that never lands. Aborting a request
 * client-side does not stop the server, so a retry can race a first attempt that
 * is still committing: without this column the second one files a duplicate lead
 * or a duplicate SIGNED WAIVER and re-sends every email.
 *
 * Nullable, because an older cached client sends nothing and must still submit.
 * Pinned here so a regeneration that loses the column fails the typecheck rather
 * than silently turning the dedupe off.
 */
export type _SubmissionIdempotencyColumns = RequireColumns<
  Tables["waivers"]["Row"] &
    Tables["interest_registrations"]["Row"] &
    Tables["contact_messages"]["Row"],
  "client_submission_id"
>;

export type _WaiverSubmissionIdIsNullable = Expect<
  Equals<Tables["waivers"]["Row"]["client_submission_id"], string | null>
>;

// ---- knowledge base: versioned pages members read and annotate ----
export type _KbArticleColumns = RequireColumns<
  Tables["kb_articles"]["Row"],
  | "id"
  | "slug"
  | "visibility"
  | "annotations_enabled"
  | "created_at"
  | "updated_at"
  | "created_by"
  | "section_id"
  | "position"
  | "nav_title"
  | "link_path"
>;

export type _KbSectionColumns = RequireColumns<
  Tables["kb_sections"]["Row"],
  "id" | "slug" | "title" | "position" | "created_at" | "updated_at"
>;

export type _KbArticleVersionColumns = RequireColumns<
  Tables["kb_article_versions"]["Row"],
  "id" | "article_id" | "version" | "title" | "body_md" | "change_note" | "is_current"
>;

export type _KbAnnotationColumns = RequireColumns<
  Tables["kb_annotations"]["Row"],
  | "id"
  | "article_id"
  | "article_version"
  | "user_id"
  | "block_id"
  | "quote"
  | "visibility"
  | "parent_id"
  | "body"
  | "resolved_at"
  | "resolved_by"
>;

/**
 * Reading progress. Committed alongside `20260802160000_kb_members_only_and_
 * reading_progress.sql`, which hand-added this table's block to `types.ts`
 * (the migration is not applied yet, so the generator has never seen it) — see
 * that migration's own header. This pins the shape that hand-add asserted, so
 * a real regeneration that lands with a different one is caught here.
 */
export type _KbArticleReadColumns = RequireColumns<
  Tables["kb_article_reads"]["Row"],
  "user_id" | "article_id" | "version" | "read_at"
>;

/**
 * The flag the "exactly one live version per article" partial unique index is
 * built on. A nullable widening would mean the NOT NULL was dropped live, and a
 * NULL here reads as "not current" to every query while satisfying the index,
 * so an article could end up with no version anyone can find.
 */
export type _KbArticleVersionIsCurrentIsBoolean = Expect<
  Equals<Tables["kb_article_versions"]["Row"]["is_current"], boolean>
>;

/**
 * Anchors are nullable on purpose: an annotation may be about the article as a
 * whole rather than a block. Pinned so a migration that makes them NOT NULL
 * fails here rather than at the first article-level comment.
 */
export type _KbAnnotationBlockIsNullable = Expect<
  Equals<Tables["kb_annotations"]["Row"]["block_id"], string | null>
>;

/**
 * `link_path` is what makes a row a sidebar LINK rather than an article, so it
 * has to stay nullable: every real article has none. A NOT NULL here would mean
 * the column had become mandatory, which no article can satisfy.
 */
export type _KbArticleLinkPathIsNullable = Expect<
  Equals<Tables["kb_articles"]["Row"]["link_path"], string | null>
>;

/**
 * The reading order. `position` carries a default and is NOT NULL, so a
 * nullable widening would let an article sort unpredictably against its
 * siblings and quietly break the onboarding path the sidebar is built on.
 */
export type _KbArticlePositionIsNumber = Expect<
  Equals<Tables["kb_articles"]["Row"]["position"], number>
>;

// ---- notifications: the /notifications page, the badge, and the emails ----

/**
 * Committed alongside `20260806030000_notifications.sql`, which hand-added this
 * table's block to `types.ts` (the migration is not applied yet, so the
 * generator has never seen it) — the same situation as `kb_article_reads`
 * above, and see that migration's own header. This pins the shape the hand-add
 * asserted, so a real regeneration landing with a different one is caught here
 * rather than at runtime.
 *
 * `read_at` and `emailed_at` are the two load-bearing columns: the first is the
 * in-app unread state behind the sidebar badge, the second is what stops a
 * notification being emailed twice. Losing either would not fail a query, it
 * would just quietly mail people again.
 */
export type _NotificationColumns = RequireColumns<
  Tables["notifications"]["Row"],
  | "id"
  | "user_id"
  | "kind"
  | "subject_type"
  | "subject_id"
  | "actor_id"
  | "title"
  | "body"
  | "href"
  | "read_at"
  | "emailed_at"
  | "created_at"
>;

/**
 * Both timestamps are nullable, and that IS the state machine: NULL `read_at`
 * means unread, NULL `emailed_at` means "not yet considered for email". A
 * NOT NULL widening on either would mean the column had gained a default, at
 * which point every notification arrives pre-read and pre-sent and the whole
 * feature silently does nothing.
 */
export type _NotificationReadAtIsNullable = Expect<
  Equals<Tables["notifications"]["Row"]["read_at"], string | null>
>;
export type _NotificationEmailedAtIsNullable = Expect<
  Equals<Tables["notifications"]["Row"]["emailed_at"], string | null>
>;

/**
 * The four switches, and the reason they are nullable: NULL means "never chose"
 * and hands that switch to `NOTIFICATION_DEFAULTS` in `src/lib/notifications.ts`.
 * A NOT NULL widening would collapse "unset" into "off", which silently opts
 * everybody out of replies and makes changing a club default impossible to
 * apply to the people who never expressed a view.
 */
export type _NotificationPreferenceColumns = RequireColumns<
  Tables["notification_preferences"]["Row"],
  "user_id" | "reply_to_me" | "thread_activity" | "new_blog_post" | "manager_comment_alerts"
>;
export type _NotificationPreferenceReplyIsNullable = Expect<
  Equals<Tables["notification_preferences"]["Row"]["reply_to_me"], boolean | null>
>;
export type _NotificationPreferenceNewPostIsNullable = Expect<
  Equals<Tables["notification_preferences"]["Row"]["new_blog_post"], boolean | null>
>;

/**
 * The credential behind the settings link in an email footer. `token` holds the
 * RAW value and is NOT NULL, unlike `calendar_feed_tokens.token`: the server has
 * to be able to put this link into an email it composes later, so a row whose
 * raw token had gone missing would be a footer link that cannot be built.
 */
export type _NotificationTokenColumns = RequireColumns<
  Tables["notification_tokens"]["Row"],
  "user_id" | "token" | "token_hash" | "token_prefix"
>;
export type _NotificationTokenRawIsNotNull = Expect<
  Equals<Tables["notification_tokens"]["Row"]["token"], string>
>;

describe("live schema contract", () => {
  it("is enforced by the typechecker, not by this test", () => {
    // Nothing to assert at runtime: the contract is the type declarations above,
    // and `bun run typecheck` is what enforces them. This case exists so the
    // file is a valid suite and so a reader of the test report is told where
    // the real check lives.
    expect(true).toBe(true);
  });
});
