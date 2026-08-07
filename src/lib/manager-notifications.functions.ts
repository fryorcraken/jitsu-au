// The manager dashboard's "needs attention" queue.
//
// This is a composition point, not a feature: each source contributes its own
// items and this module decides what order a manager meets them in. The rules
// themselves stay pure and unit-tested in `validation.ts` (the same split the
// rest of the app uses), so everything here is auth, fetch and ordering.
//
// It used to live in `membership.functions.ts`, which was right while membership
// windows were the only thing that could need attention. They are not any more.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireManager } from "@/lib/require-manager";
import { sellableWindowNotifications } from "@/lib/validation";
import type { ManagerNotification } from "@/lib/validation";
import type { MembershipClient, MembershipPlanRow } from "@/lib/membership-types";
import { listMembershipPlanRows } from "@/lib/membership.functions";

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

export const managerNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Sources are independent, so fetch them together rather than in sequence.
    const [windows] = await Promise.all([membershipWindowNotifications(supabaseAdmin)]);

    return [...windows];
  });
