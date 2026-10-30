// The I/O half of `rate-limit.ts`: claiming slots in the database counters.
//
// Server only. It lazy-loads the service-role client, so like the email
// modules it is named `*.server.ts` and only ever lazy-imported from inside a
// server-function handler. The rules (what is limited, by how much, and what
// the person is told) live in `rate-limit.ts`; this file only asks the counter.
//
// Every function here fails OPEN. A counter that cannot be reached lets the
// submission or the email through and logs why: refusing would turn a database
// hiccup into a lost waiver or a silent form, and both are worse than one
// request past a limit.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clientIp } from "@/lib/client-ip";
import { hashToken } from "@/lib/manager-api-tokens";
import { normalizeEmail } from "@/lib/validation";
import {
  BUCKETS,
  CLUB_SUBJECT,
  EMAIL_CAPS,
  FORM_LIMITS,
  networkKey,
  rateLimitMessage,
  type ManagerNoticeKind,
  type PublicForm,
} from "@/lib/rate-limit";

type AdminClient = SupabaseClient<Database>;

export type RateLimitClaim = { allowed: boolean; retryAfterSeconds: number };

/**
 * Claim one slot in a counter (`public.claim_rate_limit`).
 *
 * `dedupeKey` is what makes a retry free: the same key claiming again is let
 * through without counting. Pass the form's `client_submission_id`, or an
 * email's idempotency key. Left out, every claim counts.
 */
export async function claimRateLimit(
  admin: AdminClient,
  args: {
    bucket: string;
    subject: string;
    dedupeKey?: string | null;
    perHour?: number;
    perDay?: number;
  },
): Promise<RateLimitClaim> {
  try {
    const { data, error } = await admin.rpc("claim_rate_limit", {
      _bucket: args.bucket,
      _subject: args.subject,
      _dedupe_key: args.dedupeKey || undefined,
      _hour_max: args.perHour,
      _day_max: args.perDay,
    });
    if (error) throw new Error(error.message);
    const row = data?.[0];
    if (!row) throw new Error("claim_rate_limit returned no row");
    return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds };
  } catch (e) {
    console.error(
      `[rate-limit] could not reach the ${args.bucket} counter; letting it through:`,
      e,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Refuse a public form submission over its per-network limit, by throwing the
 * message the person sees.
 *
 * A plain `Error` with one human sentence, on purpose: `useResilientSubmit`
 * classifies that as the server saying no, so it does not retry it (which
 * would only hammer the limit), and `SubmitStatus` shows it as written in the
 * failure panel, with the form still filled in under it.
 *
 * No address at all means no limit, rather than one shared counter for every
 * request whose address went missing.
 */
export async function enforcePublicFormLimit(
  admin: AdminClient,
  getHeader: (name: string) => string | undefined,
  form: PublicForm,
  submissionId: string | null | undefined,
): Promise<void> {
  const network = networkKey(clientIp(getHeader));
  if (!network) {
    console.warn(`[rate-limit] no client address on a ${form} submission; not limiting it`);
    return;
  }
  const limit = FORM_LIMITS[form];
  const claim = await claimRateLimit(admin, {
    bucket: BUCKETS.form(form),
    subject: network,
    dedupeKey: submissionId,
    perHour: limit.perHour,
    perDay: limit.perDay,
  });
  if (!claim.allowed) {
    // No address in the log: the counter already holds the network, for a day.
    console.warn(`[rate-limit] refused a ${form} submission over the per-network limit`);
    throw new Error(rateLimitMessage(form, claim.retryAfterSeconds));
  }
}

/**
 * `enforcePublicFormLimit` for a server-function handler: resolves the
 * request's headers and the service-role client itself, so each handler needs
 * one line. Never throws for want of either; only for a real refusal.
 */
export async function limitPublicForm(
  form: PublicForm,
  submissionId: string | null | undefined,
): Promise<void> {
  let getHeader: (name: string) => string | undefined = () => undefined;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    getHeader = (name: string) => getRequestHeader(name);
  } catch {
    /* no request context: nothing to key on, so no limit */
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await enforcePublicFormLimit(supabaseAdmin, getHeader, form, submissionId);
}

/**
 * May the club email this typed-in address now? Claims the slot if so.
 *
 * Two caps, the per-address one first so a flood aimed at one stranger is
 * stopped there and does not also use up the club-wide allowance that real
 * visitors' confirmations come out of. The address is counted by its SHA-256,
 * so the counter never holds it in the clear.
 *
 * `idempotencyKey` is the email's own key, so a retried send of the same email
 * is not counted twice.
 */
export async function claimVisitorEmail(
  admin: AdminClient,
  address: string,
  idempotencyKey: string,
): Promise<boolean> {
  const perAddress = await claimRateLimit(admin, {
    bucket: BUCKETS.recipient,
    subject: await hashToken(normalizeEmail(address)),
    dedupeKey: idempotencyKey,
    perDay: EMAIL_CAPS.perRecipient,
  });
  if (!perAddress.allowed) {
    console.warn(`[rate-limit] held back ${idempotencyKey}: that address has had its emails today`);
    return false;
  }
  const total = await claimRateLimit(admin, {
    bucket: BUCKETS.visitorTotal,
    subject: CLUB_SUBJECT,
    dedupeKey: idempotencyKey,
    perDay: EMAIL_CAPS.visitorTotal,
  });
  if (!total.allowed) {
    console.warn(`[rate-limit] held back ${idempotencyKey}: the club-wide daily cap is reached`);
    return false;
  }
  return true;
}

/**
 * What to do about the managers' copy of one submission.
 *
 * - `send`: under the day's cap, email each manager as usual.
 * - `pause`: the first submission over the cap in this window. Send the
 *   managers ONE note saying the per-submission emails have stopped and where
 *   to find the rest, instead of this one.
 * - `paused`: over the cap and they have already been told. Send nothing.
 *
 * Counted per submission, not per manager, so the cap means the same thing
 * however many managers there are.
 */
export type ManagerNoticeDecision = "send" | "pause" | "paused";

export async function claimManagerNotice(
  admin: AdminClient,
  kind: ManagerNoticeKind,
  submissionKey: string,
): Promise<ManagerNoticeDecision> {
  const claim = await claimRateLimit(admin, {
    bucket: BUCKETS.manager(kind),
    subject: CLUB_SUBJECT,
    dedupeKey: submissionKey,
    perDay: EMAIL_CAPS.managerPerKind,
  });
  if (claim.allowed) return "send";
  const first = await claimRateLimit(admin, {
    bucket: BUCKETS.managerPaused(kind),
    subject: CLUB_SUBJECT,
    perDay: 1,
  });
  return first.allowed ? "pause" : "paused";
}
