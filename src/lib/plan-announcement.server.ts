// Server-only: announce a membership plan to every member, and read back what
// was announced. The rules are in `plan-announcement.ts`; this module is the
// I/O around them, and it is shared by the manager screen's server functions
// (`membership.functions.ts`) and the manager agent API, so a manager and an
// agent announce through exactly the same code.
//
// It extends the notification seam rather than running a fan-out of its own:
// rows go in through `writeNotifications`, which is what makes a retry safe;
// they are emailed by `sendPendingNotifications`, which is what makes a failed
// send a pending row rather than a lost one; and anything it leaves unsent is
// picked up by the daily digest, where it has a "Membership" section.
//
// Lazy-imported from inside handlers only. It pulls in the email renderer and
// the service-role sender, neither of which may reach the client bundle.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { MembershipPlanOpenEmail } from "@/lib/email-templates/membership-plan-open";
import { SITE_ORIGIN } from "@/lib/seo";
import {
  SITE_NAME,
  absoluteUrl,
  sendPendingNotifications,
  writeNotifications,
} from "@/lib/notification-email.server";
import {
  PLAN_ANNOUNCEMENT_KIND,
  PLAN_ANNOUNCEMENT_SUBJECT,
  announcementAudience,
  announcementBody,
  announcementSummaries,
  announcementTitle,
  forWhomText,
  joinNames,
  planAnnouncementHref,
  planNeedsInsurance,
  planPriceText,
  planRunsText,
  uninsuredNames,
  type AnnouncementInbox,
  type AnnouncementSummary,
  type AudiencePerson,
} from "@/lib/plan-announcement";
import { formatCents, greetingName, sellablePlans } from "@/lib/validation";
import type { MembershipPlanRow } from "@/lib/membership-types";

type AdminClient = SupabaseClient<Database>;

/** A refusal the caller can act on, with a code the agent API passes through. */
export class PlanAnnouncementError extends Error {
  constructor(
    readonly code: "plan_not_found" | "submission_conflict",
    message: string,
  ) {
    super(message);
    this.name = "PlanAnnouncementError";
  }
}

/** PostgREST answers at most this many rows a request, so longer reads page. */
const PAGE = 1000;

/** Every row a query would return, a page at a time. */
async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * "All members", as inboxes, read from the database.
 *
 * Throws on a failed read rather than answering with fewer people: a partial
 * audience is an announcement that silently skipped somebody.
 */
export async function loadAnnouncementAudience(db: AdminClient): Promise<{
  inboxes: AnnouncementInbox[];
  people: Map<string, AudiencePerson>;
}> {
  const [people, approved] = await Promise.all([
    readAll<AudiencePerson>((from, to) =>
      db
        .from("profiles")
        .select("user_id, guardian_user_id, first_name, middle_name, last_name, preferred_name")
        .order("user_id")
        .range(from, to),
    ),
    readAll<{ user_id: string | null }>((from, to) =>
      db
        .from("waivers")
        .select("user_id")
        .eq("approval_status", "approved")
        .order("id")
        .range(from, to),
    ),
  ]);
  return {
    inboxes: announcementAudience({
      people,
      approvedUserIds: approved.flatMap((w) => (w.user_id ? [w.user_id] : [])),
    }),
    people: new Map(people.map((p) => [p.user_id.toLowerCase(), p])),
  };
}

/** How many emails announcing a plan would send right now, for the confirm. */
export async function countAnnouncementAudience(db: AdminClient): Promise<number> {
  return (await loadAnnouncementAudience(db)).inboxes.length;
}

/**
 * Whether this plan comes with a yearly insurance line, and who already has
 * cover. Mirrors `resolveInsuranceCover` (`membership.functions.ts`), which
 * makes the same decision for one person at the moment they buy: an insurance
 * plan has to be on sale for there to be anything to add, and cover is an
 * ACTIVE insurance membership that has not yet ended.
 */
async function loadInsurance(
  db: AdminClient,
  plan: MembershipPlanRow,
): Promise<{ price: string; coveredUserIds: Set<string> } | null> {
  if (!planNeedsInsurance(plan.kind)) return null;
  const { data: insPlans, error } = await db
    .from("membership_plans")
    .select("*")
    .eq("kind", "insurance");
  if (error) throw new Error(error.message);
  const now = new Date().toISOString();
  const onSale = sellablePlans(insPlans ?? [], now).sort((a, b) => a.sort_order - b.sort_order)[0];
  if (!onSale) return null;

  const covers = await readAll<{ user_id: string | null; ends_at: string | null }>((from, to) =>
    db
      .from("memberships")
      .select("user_id, ends_at")
      .eq("status", "active")
      .in(
        "plan_id",
        (insPlans ?? []).map((p) => p.id),
      )
      .order("id")
      .range(from, to),
  );
  return {
    price: formatCents(onSale.public_price_cents),
    coveredUserIds: new Set(
      covers.flatMap((c) =>
        c.user_id && c.ends_at && c.ends_at > now ? [c.user_id.toLowerCase()] : [],
      ),
    ),
  };
}

export type AnnounceResult = {
  plan_id: string;
  announcement_id: string;
  /** Inboxes this announcement reached: the number of emails it is. */
  recipients: number;
  /** How many of them have been emailed, this call or an earlier one. */
  emailed: number;
  /** How many are still to go. Above zero, a retry or the next digest sends them. */
  pending: number;
  announced_at: string | null;
};

/**
 * Announce one plan to every member: write a row per inbox, then email them.
 *
 * `announcementId` is minted by the caller and is the whole retry story. The
 * same id again (a retried save, a double click, a timed-out request) writes no
 * new rows, because the unique index on `(user_id, kind, subject_id)` absorbs
 * them, and sends only whatever is still pending. A NEW id is a new
 * announcement, which is how a plan is announced a second time on purpose.
 *
 * The plan is read fresh, so the email describes the plan as saved, never the
 * form that saved it.
 */
export async function announceMembershipPlan(
  db: AdminClient,
  input: { planId: string; announcementId: string; actorId: string | null },
): Promise<AnnounceResult> {
  const { data: plan, error: planErr } = await db
    .from("membership_plans")
    .select("*")
    .eq("id", input.planId)
    .maybeSingle();
  if (planErr) throw new Error(planErr.message);
  if (!plan) throw new PlanAnnouncementError("plan_not_found", "That plan does not exist.");

  const href = planAnnouncementHref(plan.id);
  // One id, one plan. An id reused for a different plan would fold two
  // announcements into one and email the second plan to nobody.
  const { data: earlier, error: earlierErr } = await db
    .from("notifications")
    .select("href")
    .eq("kind", PLAN_ANNOUNCEMENT_KIND)
    .eq("subject_id", input.announcementId)
    .limit(1);
  if (earlierErr) throw new Error(earlierErr.message);
  if (earlier?.[0] && earlier[0].href !== href)
    throw new PlanAnnouncementError(
      "submission_conflict",
      "That announcement id was already used for a different plan. Start a new announcement.",
    );

  const [{ inboxes, people }, insurance] = await Promise.all([
    loadAnnouncementAudience(db),
    loadInsurance(db, plan),
  ]);

  await writeNotifications(
    db,
    inboxes.map((inbox) => ({
      userId: inbox.contactUserId,
      kind: PLAN_ANNOUNCEMENT_KIND,
      subjectType: PLAN_ANNOUNCEMENT_SUBJECT,
      subjectId: input.announcementId,
      actorId: input.actorId,
      title: announcementTitle(plan),
      body: announcementBody(plan, inbox),
      href,
    })),
    { throwOnError: true },
  );

  const byInbox = new Map(inboxes.map((i) => [i.contactUserId, i]));
  const runs = planRunsText(plan);
  const price = planPriceText(plan);

  await sendPendingNotifications(db, {
    kind: PLAN_ANNOUNCEMENT_KIND,
    subjectId: input.announcementId,
    compose: async (row, to) => {
      // Somebody who has left the audience since the row was written (a retry
      // a day later) is left pending for the digest rather than guessed at.
      const inbox = byInbox.get(row.user_id.toLowerCase());
      if (!inbox) return null;
      const reader = people.get(inbox.contactUserId);
      const uninsured = insurance
        ? uninsuredNames(inbox, {
            insuranceRequired: true,
            coveredUserIds: insurance.coveredUserIds,
          })
        : [];
      const el = React.createElement(MembershipPlanOpenEmail, {
        siteName: SITE_NAME,
        siteUrl: SITE_ORIGIN,
        greeting: reader ? greetingName(reader) : "",
        planName: plan.name,
        description: plan.description,
        runs,
        price,
        forWhom: inbox.dependants.length > 0 ? forWhomText(inbox) : null,
        insurance:
          insurance && uninsured.length > 0
            ? { who: joinNames(uninsured), price: insurance.price }
            : null,
        buyUrl: absoluteUrl(row.href),
      });
      const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
      return {
        to,
        subject: `${plan.name} at ${SITE_NAME}`,
        html,
        text,
        // The row, which is one inbox for one announcement, so two calls that
        // pick up the same pending row send one email between them.
        idempotencyKey: `plan-announcement-${row.id}`,
      };
    },
  });

  const summary = (await loadAnnouncementSummaries(db, { subjectId: input.announcementId })).get(
    plan.id,
  );
  return {
    plan_id: plan.id,
    announcement_id: input.announcementId,
    recipients: summary?.recipients ?? 0,
    emailed: summary?.emailed ?? 0,
    pending: summary ? summary.recipients - summary.emailed : 0,
    announced_at: summary?.announced_at ?? null,
  };
}

/**
 * Each plan's latest announcement, keyed by plan id. Optionally just one
 * announcement's rows, for the result of the call that sent it.
 */
export async function loadAnnouncementSummaries(
  db: AdminClient,
  opts: { subjectId?: string } = {},
): Promise<Map<string, AnnouncementSummary>> {
  const rows = await readAll<{
    subject_id: string;
    href: string;
    created_at: string;
    emailed_at: string | null;
  }>((from, to) => {
    let q = db
      .from("notifications")
      .select("subject_id, href, created_at, emailed_at")
      .eq("kind", PLAN_ANNOUNCEMENT_KIND);
    if (opts.subjectId) q = q.eq("subject_id", opts.subjectId);
    return q.order("id").range(from, to);
  });
  return announcementSummaries(rows);
}
