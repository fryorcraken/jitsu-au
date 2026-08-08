// The "needs attention" list behind /notifications.
//
// Standing problems only a manager can fix. Derived on every call and never
// stored, which is what makes them clear by being FIXED rather than by being
// dismissed — see docs/notifications.md. That is also why unanswered contact
// messages belong here rather than among the stored activity rows: they clear
// when a manager opens the inbox, and there is no per-message read state. The
// two sign-up steps arrive the same way: a waiver clears by being approved, and
// a registration by a manager opening the users list.
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

export async function managerAttentionItems(
  admin: MembershipClient,
): Promise<ManagerNotification[]> {
  // Sources are independent, so fetch them together rather than in sequence.
  // Each one degrades to "nothing to report" on its own failure rather than
  // throwing, so a bad query in one cannot empty the whole queue.
  const [windows, unreadContact, waitingWaivers, newLeads] = await Promise.all([
    membershipWindowNotifications(admin),
    countUnreadContactMessages(admin),
    countWaiversAwaitingApproval(admin),
    countNewInterestRegistrations(admin),
  ]);

  return composeManagerNotifications({
    waiverApprovals: waiverApprovalNotifications(waitingWaivers),
    contactMessages: contactMessageNotifications(unreadContact),
    interestRegistrations: interestRegistrationNotifications(newLeads),
    membershipWindows: windows,
  });
}
