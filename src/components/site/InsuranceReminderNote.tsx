// The reminder line under a yearly insurance membership on a manager screen:
// "14-day reminder sent 26 Feb". Renders nothing for any other plan, or when
// there is nothing to say. The wording is `insuranceReminderLabel`'s, so the
// screens and the agent API describe the same row the same way.
import { insuranceReminderLabel, type InsuranceReminderState } from "@/lib/insurance-reminders";

export function InsuranceReminderNote({ state }: { state: InsuranceReminderState | null }) {
  const label = insuranceReminderLabel(state);
  if (!label) return null;
  return <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>;
}
