// The "needs attention" list behind /notifications.
//
// Standing problems only a manager can fix. Derived on every call and never
// stored, which is what makes them clear by being FIXED rather than by being
// dismissed — see docs/notifications.md. That is also why unanswered contact
// messages belong here rather than among the stored activity rows: they clear
// when a manager opens the inbox, and there is no per-message read state. The
// two sign-up steps arrive the same way: a waiver clears by being approved, and
// a registration by a manager opening the users list. The stalled digest is the
// same shape again: it clears by the email actually going out, and there is
// deliberately no way to tick it off while it has not.
//
// This is a composition point, not a feature: each source contributes its own
// items and this module decides what order a manager meets them in. The rules
// themselves stay pure and unit-tested in `validation.ts`, so everything here
// is fetch and ordering.
//
// A plain exported function rather than a `createServerFn`, the same shape as
// `listMembershipPlanRows`: its one caller is `listMyNotifications` in
// `notifications.functions.ts`, which already has the caller's identity and has
// checked the manager role. Two server functions deriving this list would be two
// places for the rule to drift.
//
// It lived in `membership.functions.ts` while membership windows were the only
// source. With a second one, composing it there would make every future source a
// membership concern.
import {
  composeManagerNotifications,
  contactMessageNotifications,
  digestStalledNotifications,
  DIGEST_STALL_HOURS,
  interestRegistrationNotifications,
  sellableWindowNotifications,
  waiverApprovalNotifications,
} from "@/lib/validation";
import type { ManagerNotification } from "@/lib/validation";
import type { MembershipClient, MembershipPlanRow } from "@/lib/membership-types";
import { listMembershipPlanRows } from "@/lib/membership.functions";
import { countUnreadContactMessages } from "@/lib/contact-messages.functions";
import { countNewInterestRegistrations } from "@/lib/leads.functions";
import { countWaiversAwaitingApproval } from "@/lib/waiver.functions";

/**
 * "Nothing is defined after the current training period, so enrolments stop
 * when it ends." Only dated plans (`starts_on`/`ends_on` both set) can need a
 * successor: an undated one (trial, casual, insurance) never runs out of
 * training dates to sell.
 */
async function membershipWindowNotifications(
  admin: MembershipClient,
): Promise<ManagerNotification[]> {
  const plans = await listMembershipPlanRows(admin);
  const dated = plans.filter(
    (p): p is MembershipPlanRow & { starts_on: string; ends_on: string } =>
      p.starts_on != null && p.ends_on != null,
  );
  return sellableWindowNotifications(dated, new Date().toISOString());
}

/**
 * "The daily email summary has stopped going out." The backlog of notification
 * rows still carrying a NULL `emailed_at` well after the run that should have
 * cleared them, which is the only honest signal the digest has that it worked:
 * its scheduler reports success no matter what the site answered. See
 * `digestStalledNotifications` and docs/notifications.md.
 *
 * Three reads, in order, and each one only happens because the last said it had
 * to: how big the backlog is, whether anything has been emailed at all lately,
 * and how old the oldest waiting row is. A healthy club stops at the first.
 *
 * Exported for its own tests, the same as the three `countX` sources it sits
 * alongside. `managerAttentionItems` is its only caller in the app.
 *
 * Read here rather than in `notifications.functions.ts`, which owns every other
 * query against this table, on purpose: that module imports this one, and a
 * count reaching back the other way would put an import cycle between the page
 * and the list it renders. `membershipWindowNotifications` above already sets
 * the precedent that a source can do its own reading here.
 */
export async function digestBacklogNotifications(
  admin: MembershipClient,
  now: Date,
): Promise<ManagerNotification[]> {
  const cutoff = new Date(now.getTime() - DIGEST_STALL_HOURS * 3_600_000).toISOString();

  const { count, error } = await admin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("emailed_at", null)
    .lt("created_at", cutoff);
  // Degrade rather than throw, exactly as the three counts below do: a failed
  // read here must not empty the queue around it. Reporting nothing is the safe
  // direction for this one specifically, since the alternative is telling a
  // manager the club's email is broken on the strength of a query that failed.
  if (error) {
    console.error("[notifications] could not count the unemailed backlog:", error);
    return [];
  }
  const stalled = count ?? 0;
  // The quiet case is the common one, so it costs one query and stops here.
  if (stalled === 0) return [];

  // A backlog alone does not mean the digest has stopped, and this is the
  // difference between an alarm and a false alarm that can never be cleared.
  // `sendDailyDigests` stamps per person and swallows one recipient's failure,
  // so an address that bounces every night keeps ITS rows unstamped for good
  // while everybody else is served. Those rows would otherwise pin an
  // undismissable "the summary has stopped" item on a digest that is working.
  //
  // So: also require that NOTHING at all has been emailed inside the same
  // window. Every row a run considers is stamped, including the ones a
  // preference suppressed, so a single working run leaves evidence here even if
  // it sent no mail. No evidence plus an ageing backlog is the real thing.
  const { count: emailedRecently, error: recentError } = await admin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .gte("emailed_at", cutoff);
  if (recentError) {
    console.error("[notifications] could not check for recent digest sends:", recentError);
    return [];
  }
  if ((emailedRecently ?? 0) > 0) return [];

  const { data: first, error: oldestError } = await admin
    .from("notifications")
    .select("created_at")
    .is("emailed_at", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  // The count is the part the item cannot do without; a missing date only makes
  // the copy vaguer, so this one degrades without giving up the item.
  if (oldestError) {
    console.error("[notifications] could not read the oldest unemailed row:", oldestError);
  }
  return digestStalledNotifications({ stalled, oldestAt: first?.created_at ?? null });
}

export async function managerAttentionItems(
  admin: MembershipClient,
): Promise<ManagerNotification[]> {
  // Sources are independent, so fetch them together rather than in sequence.
  //
  // The three counts and the digest backlog degrade to "nothing to report" on
  // their own failed reads, so one bad query cannot empty the queue around it.
  // The membership windows are the exception and still throw, which
  // `Promise.all` turns into a failed notifications payload: the page then says
  // it could not load and offers a retry, which is honest, rather than
  // reporting all quiet.
  const [windows, unreadContact, waitingWaivers, newLeads, digestStalled] = await Promise.all([
    membershipWindowNotifications(admin),
    countUnreadContactMessages(admin),
    countWaiversAwaitingApproval(admin),
    countNewInterestRegistrations(admin),
    digestBacklogNotifications(admin, new Date()),
  ]);

  return composeManagerNotifications({
    waiverApprovals: waiverApprovalNotifications(waitingWaivers),
    contactMessages: contactMessageNotifications(unreadContact),
    digestStalled,
    interestRegistrations: interestRegistrationNotifications(newLeads),
    membershipWindows: windows,
  });
}
