// Server-only: the daily insurance reminders, and the reminder state the
// manager screens and the agent API report.
//
// Called by the daily job (`/api/notifications/digest`) before the summary, so
// there is one scheduler, not two. The order inside a run is what makes it
// safe on Cloudflare, where nothing outlives the response:
//
//   1. WRITE the rows owed today. Cheap, and idempotent through the unique
//      index on (user_id, kind, subject_id): each person gets each reminder
//      once per membership, however often this runs.
//   2. WITHDRAW pending rows that are no longer owed (they renewed, a manager
//      cancelled the cover, the window passed). Deleted rather than stamped,
//      so `emailed_at` on one of these rows only ever means "it went out", and
//      the "Reminder sent" a manager reads is true.
//   3. SEND what is pending, in a bounded batch, and stamp `emailed_at` only on
//      a successful send. Anything left over or failed stays pending and goes
//      out on the next run, and the stalled-digest attention item already
//      watches for rows that sit unsent.
//
// The rules (who, which reminder, what it says) are pure, in
// `insurance-reminders.ts`. This module is reads, writes and sends.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { InsuranceReminderEmail } from "@/lib/email-templates/insurance-reminder";
import { SITE_NAME, SITE_URL, emailConfigured, sendClubEmail } from "@/lib/email-send.server";
import { loadHouseholdContacts } from "@/lib/household-email";
import { contactUserIdFor } from "@/lib/household";
import { writeNotifications } from "@/lib/notification-email.server";
import {
  INSURANCE_ENDED_CAP_DAYS,
  insuranceReminderCopy,
  insuranceReminderKinds,
  insuranceReminderTitle,
  insuranceRemindersDue,
  insuranceRenewHref,
  type DueInsuranceReminder,
  type InsuranceCover,
  type InsuranceReminderKind,
  type InsuranceReminderState,
} from "@/lib/insurance-reminders";
import {
  addCalendarDays,
  clubDayStart,
  clubToday,
  greetingName,
  stableCode,
} from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/**
 * How many emails one run sends at most. The club sends a handful a month; the
 * bound is there so a backlog (the migration applied late, a week of failed
 * sends) drains over a few mornings rather than in one request that times out
 * halfway and leaves nothing stamped.
 */
const SEND_BATCH = 50;

/** PostgREST renders `.in()` into the URL; same chunk size as household-email.ts. */
const ID_CHUNK = 100;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK));
  return out;
}

/** The ids of every plan whose KIND is insurance. Never the plan code. */
async function insurancePlanIds(db: AdminClient): Promise<string[]> {
  const { data, error } = await db.from("membership_plans").select("id").eq("kind", "insurance");
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => p.id);
}

/**
 * Every insurance membership the reminder rules could need today: anything not
 * cancelled that ends on or after the oldest day an "ended" reminder may still
 * go out. That also covers the renewal check, since a renewal ends later.
 */
export async function loadInsuranceCovers(db: AdminClient, now: Date): Promise<InsuranceCover[]> {
  const planIds = await insurancePlanIds(db);
  if (planIds.length === 0) return [];
  const since = clubDayStart(addCalendarDays(clubToday(now), -INSURANCE_ENDED_CAP_DAYS));
  const { data, error } = await db
    .from("memberships")
    .select("id, user_id, status, ends_at")
    .in("plan_id", planIds)
    .neq("status", "cancelled")
    .gte("ends_at", since);
  if (error) throw new Error(error.message);
  return data ?? [];
}

type PersonRow = {
  user_id: string;
  guardian_user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
};

async function readPeople(db: AdminClient, ids: string[]): Promise<Map<string, PersonRow>> {
  const byId = new Map<string, PersonRow>();
  for (const slice of chunks([...new Set(ids)])) {
    const { data, error } = await db
      .from("profiles")
      .select("user_id, guardian_user_id, first_name, last_name, preferred_name")
      .in("user_id", slice);
    if (error) throw new Error(error.message);
    for (const p of data ?? []) byId.set(p.user_id, p);
  }
  return byId;
}

export type InsuranceReminderRun = {
  /** Reminders owed today, across the club. */
  due: number;
  /** Rows written this run (new ones only). */
  written: number;
  /** Pending rows deleted because they were no longer owed. */
  withdrawn: number;
  /** Emails sent. One per inbox, per reminder, per end day. */
  sent: number;
};

/**
 * The daily run. Throws only on a failed READ before anything is written, so
 * the caller can log it and carry on with the summary; everything after that
 * degrades per email, never stamping what did not go out.
 */
export async function sendInsuranceReminders(
  db: AdminClient,
  now = new Date(),
): Promise<InsuranceReminderRun> {
  const today = clubToday(now);
  const due = insuranceRemindersDue(await loadInsuranceCovers(db, now), now);
  const dueByKey = new Map(due.map((d) => [`${d.kind}:${d.membershipId}`, d]));

  const people = await readPeople(
    db,
    due.map((d) => d.userId),
  );

  // ---- 1. write ----
  // Only for people with a club record: `notifications.user_id` references
  // `profiles`, and one row that fails the reference fails the whole batch.
  const written = await writeNotifications(
    db,
    due
      .filter((d) => people.has(d.userId))
      .map((d) => {
        const person = people.get(d.userId)!;
        const child = person.guardian_user_id ? d.userId : null;
        return {
          userId: d.userId,
          kind: d.kind,
          subjectType: "membership" as const,
          subjectId: d.membershipId,
          title: insuranceReminderTitle(d.kind, d.endDay, child ? greetingName(person) : null),
          href: insuranceRenewHref(child),
        };
      }),
  );

  // ---- 2. withdraw ----
  const { data: pendingRows, error: pendingErr } = await db
    .from("notifications")
    .select("id, user_id, kind, subject_id")
    .in("kind", [...insuranceReminderKinds])
    .is("emailed_at", null)
    .limit(1000);
  if (pendingErr) throw new Error(pendingErr.message);

  const owed: { id: string; due: DueInsuranceReminder }[] = [];
  const stale: string[] = [];
  for (const r of pendingRows ?? []) {
    const d = dueByKey.get(`${r.kind}:${r.subject_id}`);
    if (d && d.userId === r.user_id) owed.push({ id: r.id, due: d });
    else stale.push(r.id);
  }
  for (const slice of chunks(stale)) {
    // `emailed_at IS NULL` again, so a row a concurrent run just sent is never
    // deleted out from under its "Reminder sent" line.
    const { error } = await db
      .from("notifications")
      .delete()
      .in("id", slice)
      .is("emailed_at", null);
    if (error) console.error("[insurance] could not withdraw reminders:", error.message);
  }

  const result: InsuranceReminderRun = {
    due: due.length,
    written: written.length,
    withdrawn: stale.length,
    sent: 0,
  };
  if (owed.length === 0) return result;
  if (!emailConfigured()) {
    // Left pending, not stamped: they are still owed.
    console.warn("[insurance] LOVABLE_API_KEY not set — reminders left pending");
    return result;
  }

  // ---- 3. send ----
  // One email per inbox, per reminder, per end day. A parent whose two
  // children's cover ends on the same day gets one email naming both.
  const contacts = await loadHouseholdContacts(
    db,
    owed.map((o) => o.due.userId),
  );
  const groups = new Map<
    string,
    { contactId: string; kind: InsuranceReminderKind; endDay: string; rows: typeof owed }
  >();
  for (const o of owed) {
    const person = people.get(o.due.userId);
    const contactId = person ? contactUserIdFor(person) : o.due.userId;
    const key = `${contactId}|${o.due.kind}|${o.due.endDay}`;
    const g = groups.get(key) ?? { contactId, kind: o.due.kind, endDay: o.due.endDay, rows: [] };
    g.rows.push(o);
    groups.set(key, g);
  }

  // The greeting is the READER's name, and a guardian may not be among the
  // people the reminders are about (a parent who does not train).
  const readers = await readPeople(
    db,
    [...groups.values()].map((g) => g.contactId).filter((id) => !people.has(id)),
  );
  const nameOf = (id: string) => people.get(id) ?? readers.get(id);

  for (const g of [...groups.values()].slice(0, SEND_BATCH)) {
    try {
      const to = contacts.deliveryEmail(g.contactId);
      if (!to) {
        // Left pending: every person has an address, so a null is a failed
        // lookup, and the next run tries again.
        console.error("[insurance] no address resolved for a recipient; leaving rows pending");
        continue;
      }
      const copy = insuranceReminderCopy({
        kind: g.kind,
        endDay: g.endDay,
        today,
        people: g.rows.map((r) => ({
          userId: r.due.userId,
          name:
            r.due.userId === g.contactId ? null : greetingName(nameOf(r.due.userId) ?? {}) || null,
        })),
      });
      const el = React.createElement(InsuranceReminderEmail, {
        siteName: SITE_NAME,
        greeting: `Hi ${greetingName(nameOf(g.contactId) ?? {}) || "there"}`,
        heading: copy.heading,
        body: copy.body,
        renewUrl: `${SITE_URL}${copy.renewHref}`,
      });
      const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
      const ids = g.rows.map((r) => r.id);
      await sendClubEmail({
        to,
        subject: copy.subject,
        html,
        text,
        // Keyed on the rows it covers, like the digest: the same rows always
        // make the same key, so a retry after a lost response is discarded by
        // the provider rather than delivered twice.
        idempotencyKey: `insurance-${g.kind}-${g.contactId}-${g.endDay}-${ids.length}${stableCode([...ids].sort().join(","))}`,
      });
      const { error } = await db
        .from("notifications")
        .update({ emailed_at: new Date().toISOString() })
        .in("id", ids);
      if (error) console.error("[insurance] could not stamp emailed_at:", error.message);
      result.sent += 1;
    } catch (e) {
      console.error("[insurance] a reminder failed to send:", e);
    }
  }
  return result;
}

/**
 * Reminder state for the insurance memberships among `rows`, keyed by
 * membership id. The one projection behind `/manager/memberships`, a person's
 * page, `list_invoices` and `list_users`, so the screens and the API cannot
 * disagree. A membership on any other plan is absent from the map.
 *
 * Throws on a failed read, like the rest of those listings: a missing "sent"
 * line would read as "never reminded".
 */
export async function loadInsuranceReminderStates(
  db: AdminClient,
  rows: readonly { id: string; user_id: string | null; plan_id: string }[],
  now = new Date(),
): Promise<Map<string, InsuranceReminderState>> {
  const planIds = new Set(await insurancePlanIds(db));
  const insurance = rows.filter((r) => planIds.has(r.plan_id));
  const states = new Map<string, InsuranceReminderState>();
  if (insurance.length === 0) return states;

  // Everything the renewal check needs: every insurance membership these
  // people hold, not only the ones on this page.
  const userIds = [...new Set(insurance.map((r) => r.user_id).filter((id): id is string => !!id))];
  const covers: InsuranceCover[] = [];
  for (const slice of chunks(userIds)) {
    const { data, error } = await db
      .from("memberships")
      .select("id, user_id, status, ends_at")
      .in("plan_id", [...planIds])
      .in("user_id", slice);
    if (error) throw new Error(error.message);
    covers.push(...(data ?? []));
  }
  const endingSoon = new Set(
    insuranceRemindersDue(covers, now)
      .filter((d) => d.kind === "insurance_ending_soon")
      .map((d) => d.membershipId),
  );

  const lastSent = new Map<string, { kind: InsuranceReminderKind; sent_at: string }>();
  for (const slice of chunks(insurance.map((r) => r.id))) {
    const { data, error } = await db
      .from("notifications")
      .select("subject_id, kind, emailed_at")
      .in("kind", [...insuranceReminderKinds])
      .in("subject_id", slice)
      .not("emailed_at", "is", null);
    if (error) throw new Error(error.message);
    for (const n of data ?? []) {
      if (!n.emailed_at) continue;
      const prev = lastSent.get(n.subject_id);
      if (!prev || n.emailed_at > prev.sent_at) {
        lastSent.set(n.subject_id, {
          kind: n.kind as InsuranceReminderKind,
          sent_at: n.emailed_at,
        });
      }
    }
  }

  for (const r of insurance) {
    states.set(r.id, {
      ends_within_14_days: endingSoon.has(r.id),
      last_sent: lastSent.get(r.id) ?? null,
    });
  }
  return states;
}

/**
 * How many PEOPLE are owed an "ending soon" reminder today, for the manager's
 * attention item. Degrades to 0 on a failed read, like the other counts on that
 * list: one bad query must not empty the queue around it.
 */
export async function countPeopleWithInsuranceEnding(
  db: AdminClient,
  now = new Date(),
): Promise<number> {
  try {
    const due = insuranceRemindersDue(await loadInsuranceCovers(db, now), now);
    return new Set(due.filter((d) => d.kind === "insurance_ending_soon").map((d) => d.userId)).size;
  } catch (e) {
    console.error("[insurance] could not count people whose insurance is ending:", e);
    return 0;
  }
}
