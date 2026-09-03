// Manager: everything known about ONE person, for the user detail screen.
//
// The list screen (`listClubUsers`) answers "who does the club know"; this
// answers "who is this person": their profile, their memberships, and every
// waiver they ever submitted with the full frozen submission so a manager can
// read what was signed without leaving the page.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deriveWaiverListStatuses,
  managerEmailChangeSchema,
  managerKitSizesSchema,
  nameWithPreferred,
  normalizeEmail,
} from "@/lib/validation";
import { CODE_OF_CONDUCT_VERSION, codeOfConductState } from "@/lib/code-of-conduct";
import type { MembershipClient } from "@/lib/membership-types";
import { personLabelsById, type ClubUserEmail } from "@/lib/club-users";
import { userEmails, userIdByEmail } from "@/lib/supabase-rpc";
import { contactUserIdFor, isDependantUser } from "@/lib/household";

/** Max waiver / membership rows one person's page pulls. */
const WAIVERS_LIMIT = 100;
const MEMBERSHIPS_LIMIT = 100;
/**
 * Check-ins shown on a person's page. This caps the VISIBLE HISTORY only: the
 * headline total comes from its own exact count below, because feeding the
 * capped array to the aggregation would silently report anyone past the cap as
 * having trained exactly 100 times.
 */
const CHECKINS_LIMIT = 100;

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: MembershipClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

export const getClubUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { aggregateClubUsers } = await import("@/lib/club-users");

    const [
      { data: profile, error: pErr },
      { data: waivers, error: wErr },
      { data: memberships, error: mErr },
      { data: plans, error: plErr },
      { data: roles, error: rErr },
      { data: checkins, error: cErr },
      { count: checkinCount, error: ccErr },
      { data: codeOfConduct, error: cocErr },
      { data: dependantProfiles, error: dErr },
    ] = await Promise.all([
      admin.from("profiles").select("*").eq("user_id", data.userId).maybeSingle(),
      admin
        .from("waivers")
        .select("*")
        .eq("user_id", data.userId)
        .order("signed_at", { ascending: false })
        .limit(WAIVERS_LIMIT),
      admin
        .from("memberships")
        .select("*")
        .eq("user_id", data.userId)
        .order("created_at", { ascending: false })
        .limit(MEMBERSHIPS_LIMIT),
      admin.from("membership_plans").select("id, name, kind, starts_on, ends_on, duration_days"),
      admin.from("user_roles").select("user_id, role").eq("user_id", data.userId),
      admin
        .from("session_checkins")
        .select("id, event_id, checked_in_at, coverage, membership_id, consumed_credit, warnings")
        .eq("user_id", data.userId)
        .order("checked_in_at", { ascending: false })
        .limit(CHECKINS_LIMIT),
      // The real total, uncapped. `/manager/users` counts the same thing a
      // different way, and the two must agree or a manager reading a grading
      // decision off this page gets a number nobody else sees.
      admin
        .from("session_checkins")
        .select("id", { count: "exact", head: true })
        .eq("user_id", data.userId),
      admin
        .from("code_of_conduct_acceptances")
        .select("id, version, accepted_at, signature_name")
        .eq("user_id", data.userId)
        .order("accepted_at", { ascending: false })
        .limit(20),
      // The people on THIS person's account. Read here rather than after the
      // profile comes back because it is keyed on the id we were asked about,
      // not on anything the profile tells us -- so it costs no extra round trip.
      admin
        .from("profiles")
        .select("user_id, guardian_user_id, first_name, middle_name, last_name, preferred_name")
        .eq("guardian_user_id", data.userId)
        .order("first_name", { ascending: true }),
    ]);
    // Every read except the email RPC fails the whole page. This is the screen a
    // manager decides an approval from, so "the query failed" must never render
    // as "there is nothing there": an errored memberships read would otherwise
    // feed an empty list to the aggregation below and show a paid-up member as a
    // visitor with no memberships. `listClubUsers` holds the same line for the
    // directory it lists this person in.
    if (pErr) throw new Error(pErr.message);
    if (wErr) throw new Error(wErr.message);
    if (mErr) throw new Error(mErr.message);
    if (plErr) throw new Error(plErr.message);
    if (rErr) throw new Error(rErr.message);
    if (cErr) throw new Error(cErr.message);
    if (ccErr) throw new Error(ccErr.message);
    // Fails the page for the reason the comment above gives, not merely for
    // symmetry: since #107 a guardian's `member` phase counts their dependants'
    // memberships, so degrading this read to "nobody" would show a paid-up
    // family's parent as a lead, on the screen a manager decides an approval
    // from, and would disagree with the directory that lists the same person.
    if (dErr) throw new Error(dErr.message);
    if (!profile) throw new Error("User not found.");

    // Whose address belongs on this page. For an account holder that is their
    // own; for a dependant it is their guardian's, and the reserved,
    // non-deliverable string on the child's own login is never asked for at
    // all -- which is why this is a round of its own rather than part of the
    // one above: the guardian's id is only known once the profile has come
    // back. One extra round trip on a manager page, in exchange for never
    // fetching an address that identifies nobody.
    // Through the helper rather than an inline `??`: `household.ts` says why
    // that is a function at all. "Which id do I ask for an address?" has to
    // have exactly one answer, because the wrong one here is a reserved,
    // non-deliverable string that identifies nobody.
    const contactId = contactUserIdFor(profile);
    const dependantRows = dependantProfiles ?? [];
    const dependantIds = dependantRows.map((d) => d.user_id);
    const [contactEmails, guardianProfile, dependantMemberships] = await Promise.all([
      userEmails(admin, [contactId]),
      profile.guardian_user_id
        ? admin
            .from("profiles")
            .select("user_id, guardian_user_id, first_name, middle_name, last_name, preferred_name")
            .eq("user_id", profile.guardian_user_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // Only what the `member` phase is derived from, and only when there is
      // somebody to ask about. Not the whole membership history: these rows are
      // never listed on this page, they only answer "is anybody on this
      // person's account paid up right now".
      dependantIds.length
        ? admin
            .from("memberships")
            .select("id, user_id, plan_id, status, price_cents, created_at")
            .in("user_id", dependantIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    // Fails the page, for the same reason the dependants read above does: it
    // feeds the funnel phase, and a guardian silently demoted to `lead` is a
    // wrong answer rather than a missing one.
    if (dependantMemberships.error) throw new Error(dependantMemberships.error.message);
    // Same posture as the lookup this replaced: a failed address read degrades
    // to a missing email rather than taking down the screen a manager approves
    // from. A failed GUARDIAN read is logged for the same reason: the page
    // still works, it just cannot name whose address it is showing.
    const emailErr = contactEmails.error;
    const emailRows = contactEmails.data;
    if (guardianProfile.error)
      console.error("[getClubUser] guardian profile lookup failed:", guardianProfile.error);

    const waiverRows = waivers ?? [];
    const membershipRows = memberships ?? [];
    const planRows = plans ?? [];
    const planById = new Map(planRows.map((p) => [p.id, p]));

    // Surface the caps rather than silently showing a partial history. Both
    // read newest first, so what falls off is ancient; note the waiver cap can
    // in principle drop an old submission that was approved most recently
    // (status is derived by approved_at, the query truncates by signed_at).
    if (waiverRows.length >= WAIVERS_LIMIT) {
      console.warn(`[getClubUser] waivers capped at ${WAIVERS_LIMIT}; older submissions truncated`);
    }
    if (membershipRows.length >= MEMBERSHIPS_LIMIT) {
      console.warn(
        `[getClubUser] memberships capped at ${MEMBERSHIPS_LIMIT}; older ones truncated`,
      );
    }

    // The RPC is service-role only and can fail; degrade to a missing email
    // rather than failing the whole page (same posture as the list screen). A
    // person always HAS an email — it lives on their login record — so log it:
    // the screen can only say the lookup failed, and nothing else would.
    if (emailErr) console.error("[getClubUser] email lookup failed:", emailErr);

    // The code of conduct blocks nothing, so a failed read of it must not take
    // the page down with it: a manager still has an approval to make, and an
    // unreadable acceptance list is shown as "not signed yet" with a line in the
    // server log rather than an error page over a nice-to-know.
    if (cocErr) console.error("[getClubUser] code of conduct lookup failed:", cocErr);
    // Highest VERSION agreed to, not the most recent row: re-signing an older
    // version after a newer one is not a downgrade (`codeOfConductStatusFor`
    // holds the same line for the member's own screens).
    const codeOfConductRows = codeOfConduct ?? [];
    const latestCode = codeOfConductRows.reduce<(typeof codeOfConductRows)[number] | null>(
      (top, a) => (!top || a.version > top.version ? a : top),
      null,
    );
    const emails = (emailRows ?? []).map((e) => ({
      user_id: e.user_id,
      email: e.email,
      email_confirmed_at: e.email_confirmed_at ?? null,
    }));

    // One aggregation path for the funnel phase and the headline fields: reuse
    // the shared aggregator on a single-person input rather than re-deriving.
    const [summary] = aggregateClubUsers({
      profiles: [profile],
      emails,
      // Not a person on this page, only the owner of the address shown on it.
      guardians: guardianProfile.data ? [guardianProfile.data] : [],
      // Who is on this person's account. Not listed as people of their own --
      // they have their own pages -- but their memberships below decide whether
      // this person reads as a `member`, which is what makes this page agree
      // with the directory that lists them.
      dependants: dependantRows,
      waivers: waiverRows.map((w) => ({
        user_id: w.user_id,
        signed_at: w.signed_at,
        approval_status: w.approval_status,
      })),
      leads: [],
      memberships: [
        ...membershipRows.map((m) => ({
          user_id: m.user_id,
          plan_id: m.plan_id,
          status: m.status,
          price_cents: m.price_cents,
          is_student: m.is_student,
          uts_student_number: m.uts_student_number,
          sessions_remaining: m.sessions_remaining,
          created_at: m.created_at,
        })),
        // The dependants' rows, which are read ONLY through the household index
        // (nothing but `profiles` is emitted, and every per-person lookup is
        // keyed on the person being emitted). They carry no student number or
        // credit balance because nothing on this page reads either off them.
        ...(dependantMemberships.data ?? []).map((m) => ({
          user_id: m.user_id,
          plan_id: m.plan_id,
          status: m.status,
          price_cents: m.price_cents,
          is_student: false,
          uts_student_number: null,
          sessions_remaining: null,
          created_at: m.created_at,
        })),
      ],
      plans: planRows,
      roles: roles ?? [],
      // Deliberately NOT passed: the aggregation counts the array it is given,
      // and the read above is capped at CHECKINS_LIMIT. The total comes from the
      // exact count instead, below.
    });

    const statuses = deriveWaiverListStatuses(waiverRows);

    // Name the class each check-in belongs to. A separate read rather than an
    // embedded join so the row shapes stay the generated ones.
    const checkinRows = checkins ?? [];
    if (checkinRows.length >= CHECKINS_LIMIT)
      console.warn(`[getClubUser] check-ins capped at ${CHECKINS_LIMIT}; older ones truncated`);
    const eventIds = [...new Set(checkinRows.map((c) => c.event_id))];

    // Who approved each waiver. `waivers.approved_by` is a bare user id, and
    // the approver is a manager, who may well have no `profiles` row of their
    // own — so resolve the name where there is one and fall back to the login
    // address, the same two sources the memberships list uses for member names.
    const approverIds = [...new Set(waiverRows.map((w) => w.approved_by))].filter(
      (id): id is string => Boolean(id),
    );

    // Everything whose keys only exist once the first round came back, in one
    // second round rather than one round each.
    const [{ data: events }, approverProfiles, approverEmails] = await Promise.all([
      eventIds.length
        ? admin.from("calendar_events").select("id, title, starts_at").in("id", eventIds)
        : { data: [] },
      approverIds.length
        ? admin
            .from("profiles")
            .select("user_id, first_name, middle_name, last_name, preferred_name")
            .in("user_id", approverIds)
        : { data: [], error: null },
      // Approvers are managers, so never dependants: a dependant has no login
      // and cannot approve anything. Left as a direct lookup on purpose.
      approverIds.length ? userEmails(admin, approverIds) : { data: [], error: null },
    ]);
    const eventById = new Map((events ?? []).map((e) => [e.id, e]));
    // Non-fatal, like the person's own email lookup above: an unresolved
    // approver shows as "—" next to a real approval date, which is the honest
    // reading. Taking the page down over it would block the decision it exists
    // to support.
    if (approverProfiles.error)
      console.error("[getClubUser] approver profile lookup failed:", approverProfiles.error);
    if (approverEmails.error)
      console.error("[getClubUser] approver email lookup failed:", approverEmails.error);
    const approverLabels = personLabelsById({
      profiles: approverProfiles.data ?? [],
      emails: approverEmails.data ?? [],
    });

    const planNameByMembership = new Map(
      membershipRows.map((m) => [m.id, planById.get(m.plan_id)?.name ?? null]),
    );

    // Exact per-membership check-in counts, not derived from `checkinRows`
    // above: that read is capped at CHECKINS_LIMIT, and an under-count here
    // would offer a Delete the server then refuses.
    const { checkinCountsByMembership } = await import("@/lib/membership.functions");
    const checkinCounts = await checkinCountsByMembership(
      admin,
      membershipRows.map((m) => m.id),
    );

    return {
      // Only the derived headline fields, not the whole aggregate. Its
      // `uts_student_number` in particular falls back to a number captured on a
      // membership, which is exactly what the Profile card must not show — so
      // don't ship it under a name that invites someone to render it.
      user: {
        name: summary.name,
        email: summary.email,
        // Whose address that is, when it is not this person's own. A dependant
        // has no mailbox, so their page shows their guardian's and has to say
        // so: printed bare it reads as a child a manager can write to.
        email_belongs_to: summary.email_belongs_to,
        email_confirmed_at: summary.email_confirmed_at,
        phone: summary.phone,
        roles: summary.roles,
        lifecycle_status: summary.lifecycle_status,
        // Their newest membership, which is what lets the phase be named
        // properly: a `lapsed` person whose newest is a free trial that EXPIRED
        // used up their two classes, they did not let a membership run out. Both
        // halves are needed, since a trial a manager cancelled is neither.
        latest_plan_kind: summary.latest_plan_kind,
        latest_membership_status: summary.latest_membership_status,
        latest_sessions_remaining: summary.latest_sessions_remaining,
        // Classes trained, whatever paid for them: the coaching and grading
        // number, not "credits used". From the exact count, so it agrees with
        // /manager/users however long their history is.
        sessions_attended: checkinCount ?? 0,
        first_seen_at: summary.first_seen_at,
      },
      // Straight off the `profiles` row, so the screen can show the club's live
      // record as it actually is. Deliberately NOT taken from the aggregated
      // summary above, which fills gaps from other tables (its student number
      // falls back to one captured on a membership) — that would show the
      // record as complete while the column driving student pricing is null.
      profile: {
        preferred_name: profile.preferred_name,
        // Who holds this person's account, when somebody else does. The page
        // needs the ID rather than just the guardian's name (which the summary
        // already carries) because it has one question the name cannot answer:
        // whether the person who last set a photo-consent answer was the
        // guardian or a manager. Both are "not the subject".
        guardian_user_id: profile.guardian_user_id,
        phone: profile.phone,
        date_of_birth: profile.date_of_birth,
        address: profile.address,
        uts_student_number: profile.uts_student_number,
        emergency_contact_name: profile.emergency_contact_name,
        emergency_contact_relationship: profile.emergency_contact_relationship,
        emergency_contact_phone: profile.emergency_contact_phone,
        medical_notes: profile.medical_notes,
        is_minor: profile.is_minor,
        guardian_name: profile.guardian_name,
        guardian_relationship: profile.guardian_relationship,
        guardian_address: profile.guardian_address,
        guardian_phone: profile.guardian_phone,
        guardian_email: profile.guardian_email,
        sms_whatsapp_consent: profile.sms_whatsapp_consent,
        gi_size: profile.gi_size,
        belt_size: profile.belt_size,
        // Three-state: null means nobody has ever asked this person, which the
        // screen shows as "Not asked" rather than folding it into a "No" the
        // club never actually received. The two provenance fields are non-null
        // only when a manager set the value by hand after the fact.
        media_consent: profile.media_consent,
        media_consent_updated_at: profile.media_consent_updated_at,
        media_consent_updated_by: profile.media_consent_updated_by,
        updated_at: profile.updated_at,
      },
      /**
       * The family, in whichever direction this person sits in one: the account
       * holder above them, and the people on their account below.
       *
       * Both are always present and at most one is ever non-empty, because a
       * dependant may not have dependants of their own (#102's one-level rule,
       * enforced in `household.ts`). The card renders nothing when both are.
       *
       * Names only, plus the id to link on. Everything else about one of these
       * people belongs on THEIR page, which is a link away.
       */
      household: {
        guardian: profile.guardian_user_id
          ? {
              user_id: profile.guardian_user_id,
              // Null when the lookup failed, which the card says out loud
              // rather than printing a bare uuid or, worse, nothing at all: a
              // child whose parent silently vanished off this card reads as a
              // child with no parent on file.
              name: guardianProfile.data ? nameWithPreferred(guardianProfile.data) || null : null,
            }
          : null,
        dependants: dependantRows.map((d) => ({
          user_id: d.user_id,
          name: nameWithPreferred(d) || null,
        })),
      },
      memberships: membershipRows.map((m) => ({
        id: m.id,
        plan_name: planById.get(m.plan_id)?.name ?? null,
        // What the status is called depends on it: a plan sold as a number of
        // classes is "used up" when it ends, not "expired".
        kind: planById.get(m.plan_id)?.kind ?? null,
        // The plan's own window, so the row can ask whether this membership's
        // start date is a real choice with the same rule the server enforces
        // (`planStartIsChoosable`) rather than re-deriving it from `kind`.
        plan_window: (() => {
          const plan = planById.get(m.plan_id);
          return plan
            ? {
                starts_on: plan.starts_on,
                ends_on: plan.ends_on,
                duration_days: plan.duration_days,
              }
            : null;
        })(),
        status: m.status,
        price_cents: m.price_cents,
        payment_reference: m.payment_reference,
        starts_at: m.starts_at,
        ends_at: m.ends_at,
        sessions_remaining: m.sessions_remaining,
        // The three inputs to the delete guard, so the screen can say why the
        // button is unavailable instead of only that it is.
        paid_at: m.paid_at,
        checkin_count: checkinCounts.get(m.id) ?? 0,
      })),
      // Their attendance, newest first. `membership_id` with no cover is what
      // the needs-attention flow fixes, and it can be fixed from here too;
      // `membership_id` WITH cover is what a manager moves to free a membership
      // up for deletion.
      checkins: checkinRows.map((c) => ({
        id: c.id,
        event_id: c.event_id,
        event_title: eventById.get(c.event_id)?.title ?? null,
        event_starts_at: eventById.get(c.event_id)?.starts_at ?? null,
        checked_in_at: c.checked_in_at,
        coverage: c.coverage,
        membership_id: c.membership_id,
        plan_name: c.membership_id ? (planNameByMembership.get(c.membership_id) ?? null) : null,
        consumed_credit: c.consumed_credit,
        warnings: c.warnings,
      })),
      // House rules, not a gate. Shown so a manager can nudge somebody about it
      // when they join as a paying member, which is when the club wants it
      // signed. Nothing here stops an approval or a check-in.
      code_of_conduct: {
        state: codeOfConductState(latestCode?.version ?? null),
        current_version: CODE_OF_CONDUCT_VERSION,
        accepted_version: latestCode?.version ?? null,
        accepted_at: latestCode?.accepted_at ?? null,
        signature_name: latestCode?.signature_name ?? null,
      },
      // The frozen submission, in full: what a manager reads to decide whether
      // to approve. The PDF is fetched separately, as a short-lived signed URL.
      waivers: waiverRows.map((w) => ({
        id: w.id,
        full_name: nameWithPreferred(w),
        email: w.email,
        phone: w.phone,
        date_of_birth: w.date_of_birth,
        address: w.address,
        uts_student_number: w.uts_student_number,
        sms_whatsapp_consent: w.sms_whatsapp_consent,
        media_consent: w.media_consent,
        emergency_contact_name: w.emergency_contact_name,
        emergency_contact_relationship: w.emergency_contact_relationship,
        emergency_contact_phone: w.emergency_contact_phone,
        medical_notes: w.medical_notes,
        is_minor: w.is_minor,
        guardian_name: w.guardian_name,
        guardian_relationship: w.guardian_relationship,
        guardian_address: w.guardian_address,
        guardian_phone: w.guardian_phone,
        guardian_email: w.guardian_email,
        signed_at: w.signed_at,
        template_version: w.template_version,
        has_pdf: Boolean(w.pdf_path),
        approved_at: w.approved_at ?? null,
        // Who signed off. Null both while pending and for an approval recorded
        // before the column existed, so the screen shows it as unknown rather
        // than claiming nobody approved it.
        // The id as well as the name, so the panel can open the approver's own
        // record. Null while pending; a non-null id with a null name is an
        // approver whose profile and email both failed to resolve, which the
        // screen shows as an openable "Unknown" rather than as nobody.
        approved_by: w.approved_by ?? null,
        approved_by_name: w.approved_by ? (approverLabels.get(w.approved_by) ?? null) : null,
        signer_ip: w.signer_ip,
        signer_meta: w.signer_meta,
        status: statuses.get(w.id) ?? ("pending" as const),
      })),
    };
  });

// ---- Manager: correct a person's email address ----
//
// The only email-editing path in the product. The address is the identity, so
// moving it moves the login itself, and everything the club sends afterwards.
//
// The rule this enforces: a changed address is ALWAYS unverified. Whatever was
// proven about the old address says nothing about the new one, and the whole
// point of the badge is that it cannot be set by someone's say-so.
/**
 * Change a person's login email, as a manager: the whole rule, with the client
 * passed in.
 *
 * A plain function rather than the server handler's body for the reason
 * `checkin.functions.ts` gives about `applyCoverage`: a `createServerFn`
 * handler cannot be called from the test runner (it dies on "No Start context
 * found in AsyncLocalStorage"), and this one carries enough rules worth pinning
 * -- who may be pointed at what, that the address really moved, that the
 * verified badge is dropped rather than assumed dropped -- to be worth reaching.
 *
 * `email` is normalised by the caller, which is also what makes the "re-saving
 * the same address" comparison below meaningful.
 */
export async function changeClubUserEmail(
  admin: SupabaseClient<Database>,
  userId: string,
  email: string,
) {
  // #102's sharp edge, and the last of it: "refuse to point an account holder's
  // address at a dependant, and refuse to edit a dependant's reserved address at
  // all". One guard closes both, because the second contains the first.
  //
  // Asked BEFORE anything is read or written, so a refusal costs nothing and
  // leaves nothing half-done.
  //
  // What it stops is not the obvious case. Typing the parent's own address onto
  // a child was already refused by the clash check below, though for the wrong
  // reason and in a sentence about somebody else. The real hole was a FRESH
  // address: nothing stopped a manager giving a nine-year-old a working mailbox
  // on their own login. That address would then sit on a person the whole
  // product routes through their guardian, unread and unused, badged with a
  // confirmation state about an inbox nobody watches, while the reserved,
  // non-deliverable shape that makes a dependant safe (`waiver.functions.ts`,
  // and the permanent ban beside it) was quietly gone.
  if (await isDependantUser(admin, userId)) {
    throw new Error(
      "This person is on somebody else's account and has no email of their own. Change the address on the account holder's page instead.",
    );
  }

  const { data: got, error: getErr } = await admin.auth.admin.getUserById(userId);
  if (getErr) throw new Error(getErr.message);
  if (!got.user) throw new Error("User not found.");

  const current = got.user.email ? normalizeEmail(got.user.email) : "";
  // Re-saving the same address must not cost someone their verified badge.
  if (current === email) {
    return {
      ok: true as const,
      email,
      changed: false,
      verified: Boolean(got.user.email_confirmed_at),
    };
  }

  // One person per email is the model's core invariant: profiles, waivers and
  // memberships all hang off a single auth user resolved by address. Merging
  // two people is a different problem, so refuse rather than half-do it.
  const { data: clash, error: clashErr } = await userIdByEmail(admin, email);
  if (clashErr) throw new Error(clashErr.message);
  if (clash && clash !== userId) {
    throw new Error("That email already belongs to another person.");
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: false,
  });
  if (updErr) throw new Error(updErr.message);

  // Assert the address actually MOVED, rather than trusting that it did.
  // Some GoTrue configurations answer an email update by parking the new
  // address in a pending `email_change` and leaving `email` alone. That would
  // return success here while the person still holds the wrong address — the
  // exact failure this feature exists to make visible. Re-read and check.
  const { data: after, error: afterErr } = await admin.auth.admin.getUserById(userId);
  if (afterErr) throw new Error(afterErr.message);
  const moved = after.user?.email ? normalizeEmail(after.user.email) === email : false;
  if (!moved) {
    throw new Error(
      "The login record did not accept that email. Nothing was changed. Check the address and try again.",
    );
  }

  // The guarantee. The admin API declines to SET a confirmation when asked
  // not to, but does not reliably CLEAR an existing one, so drop it outright
  // rather than trusting GoTrue to have done it.
  const { error: clearErr } = await admin.rpc("clear_email_confirmation", {
    _user_id: userId,
  });
  if (clearErr) throw new Error(clearErr.message);

  // Links already sitting in the old inbox go inert now rather than waiting
  // out their expiry: whoever reads that mailbox is not the person we hold.
  // Its own try/catch: a failed revoke must not skip the send below, or the
  // manager would be told a link went out when none did. A stale token cannot
  // verify the new address anyway (redemption re-checks the match), so this
  // is tidiness rather than the security boundary.
  if (current) {
    try {
      const { revokeVerificationTokensForEmail } = await import("@/lib/email-verification.server");
      await revokeVerificationTokensForEmail(admin, current);
    } catch (e) {
      console.error("[setClubUserEmail] could not revoke old-address tokens:", e);
    }
  }

  // Report what actually happened. The screen tells the manager a link was
  // sent, so that claim has to be true: a mail provider outage must show as
  // "address changed, no email sent", not as a confident lie they will only
  // discover when the member says nothing arrived.
  let verificationSent = false;
  try {
    const { sendVerificationEmail } = await import("@/lib/email-verification.server");
    ({ sent: verificationSent } = await sendVerificationEmail({
      admin,
      to: email,
      purpose: "email_change",
      userId: userId,
      next: "/account",
    }));
  } catch (e) {
    console.error("[setClubUserEmail] verification email failed:", e);
  }

  // NB: waiver rows keep the address as SUBMITTED. They are frozen evidence of
  // what was signed, so a corrected account email legitimately diverges from
  // them, and the detail screen says so rather than looking broken.
  return { ok: true as const, email, changed: true, verified: false, verificationSent };
}

export const setClubUserEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => managerEmailChangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    return changeClubUserEmail(admin, data.userId, normalizeEmail(data.email));
  });

/** Manager: send the person a fresh "confirm your email address" link. */
export const resendClubUserVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");

    // A dependant is never sent a verification link, and this is the one path
    // that could have sent one. #102 asks for that guarantee and #106 asks for
    // it to be CONFIRMED rather than assumed, so here is the confirmation: of
    // the four places that mint an `email_verification_tokens` row, the waiver
    // confirmation and the code-of-conduct link both resolve to the contact
    // person already, an interest registration is a lead with no person record
    // at all, and this one takes a bare `userId` from a manager's screen and
    // would happily mint against a child.
    //
    // What that produced was not dangerous so much as incoherent: a token bound
    // to a reserved address in a subdomain the club routes no mail for, posted
    // nowhere, redeemable by nobody, sitting in the table looking like somebody
    // was asked to confirm something. Refused outright instead.
    //
    // `changeClubUserEmail` above asks the same question for the same reason,
    // and was the neighbouring hole this comment used to point at. Both are
    // closed now: two call sites of one shared rule, not two rules.
    if (await isDependantUser(admin, data.userId)) {
      throw new Error(
        "This person is on somebody else's account and has no email of their own. Send the link to the account holder instead.",
      );
    }

    const { data: got, error } = await admin.auth.admin.getUserById(data.userId);
    if (error) throw new Error(error.message);
    if (!got.user?.email) throw new Error("That person has no email on file.");
    if (got.user.email_confirmed_at) {
      return { ok: true as const, alreadyVerified: true, email: got.user.email };
    }

    const { sendVerificationEmail } = await import("@/lib/email-verification.server");
    const { sent } = await sendVerificationEmail({
      admin,
      to: got.user.email,
      purpose: "manager_resend",
      userId: data.userId,
      next: "/account",
    });
    if (!sent) throw new Error("We couldn't send that email just now. Try again shortly.");
    return { ok: true as const, alreadyVerified: false, email: got.user.email };
  });

// ---- Manager: correct a person's kit sizes ----
//
// Sizing is equipment, not evidence: nothing on a signed waiver records it, so
// unlike the fields below it on the detail page there is no frozen submission to
// disagree with. A manager corrects it because they measured somebody, or
// because the gi that arrived did not fit.
//
// Both sides are nullable, so this is also how a wrong size gets cleared rather
// than replaced with a guess.
export const setClubUserKitSizes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => managerKitSizesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { data: updated, error } = await admin
      .from("profiles")
      .update({
        gi_size: data.gi_size,
        belt_size: data.belt_size,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", data.userId)
      .select("user_id");
    if (error) throw new Error(error.message);
    // PostgREST reports no error when the filter matched nothing. A lead has no
    // profile row (`aggregateClubUsers` synthesises those rows), so without this
    // the screen would say "Sizes updated." over a write that never landed.
    if (!updated || updated.length === 0) {
      throw new Error("That person has no profile record to hold sizes.");
    }
    return { ok: true as const, gi_size: data.gi_size, belt_size: data.belt_size };
  });
