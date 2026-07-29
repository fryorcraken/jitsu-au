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
  | "signer_ip"
  | "signer_meta"
  | "user_id"
  // How the emergency contact is related; for a minor, that contact IS the
  // guardian who signs, so this doubles as the relationship to the minor.
  | "emergency_contact_relationship"
>;

// ---- waiver_templates: the manager-editable acknowledgements ----
export type _TemplateColumns = RequireColumns<
  Tables["waiver_templates"]["Row"],
  "acknowledgements" | "body_md" | "created_at" | "id" | "is_current" | "title" | "version"
>;

// ---- profiles: the fields waiver approval copies across ----
export type _ProfileColumns = RequireColumns<
  Tables["profiles"]["Row"],
  | "user_id"
  | "first_name"
  | "preferred_name"
  | "uts_student_number"
  | "sms_whatsapp_consent"
  | "emergency_contact_relationship"
>;

// ---- interest_registrations: the consent flag the public form writes ----
export type _InterestColumns = RequireColumns<
  Tables["interest_registrations"]["Row"],
  "sms_whatsapp_consent"
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

describe("live schema contract", () => {
  it("is enforced by the typechecker, not by this test", () => {
    // Nothing to assert at runtime: the contract is the type declarations above,
    // and `bun run typecheck` is what enforces them. This case exists so the
    // file is a valid suite and so a reader of the test report is told where
    // the real check lives.
    expect(true).toBe(true);
  });
});
