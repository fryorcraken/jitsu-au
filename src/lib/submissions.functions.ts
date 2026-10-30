import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { contactSchema, interestSchema } from "@/lib/validation";

function serverSupabase() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
          h.delete("Authorization");
        }
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/**
 * Postgres unique-violation. The public intake tables grant `anon` INSERT and
 * deliberately no SELECT, so a repeat submission cannot be detected by looking
 * first: the partial unique index on `client_submission_id` raises this instead,
 * and that IS the "already recorded" signal.
 */
const UNIQUE_VIOLATION = "23505";

/**
 * Turn somebody away once their network has sent too many (#52). First thing
 * each handler does after the honeypot, before anything is written or sent.
 * The submission id is passed so an automatic retry of one form fill is not
 * counted as a second submission. Throws the message the person sees.
 */
async function limit(form: "interest" | "contact", submissionId: string | null) {
  const { limitPublicForm } = await import("@/lib/rate-limit.server");
  await limitPublicForm(form, submissionId);
}

export const submitInterest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => interestSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, duplicate: false, emailed: true };
    await limit("interest", data.client_submission_id || null);
    const supabase = serverSupabase();
    // Providing a phone number here is implicit consent to SMS/WhatsApp contact
    // (the phone field carries a consent note). Record it so later forms can
    // prefill their consent checkbox.
    //
    // A registration is a LEAD: just this row, nothing else. The person record
    // (locked login + profile) starts later, when they sign the waiver.
    // NB: this table grants anon INSERT only (no SELECT), so we must NOT ask
    // PostgREST to return the row (`.select()`) — that needs SELECT privilege
    // and would error. The idempotency key below is generated instead.
    // One id per form fill, resent unchanged on every retry. Without it an
    // automatic retry after a lost reply would file the same person twice and
    // email them twice, which is what made retrying unsafe before.
    const submissionId = data.client_submission_id || null;

    const { error } = await supabase.from("interest_registrations").insert({
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      sms_whatsapp_consent: Boolean(data.phone && data.phone.trim()),
      message: data.message || null,
      client_submission_id: submissionId,
    });
    if (error) {
      // This exact registration is already filed. Report success (it IS
      // recorded) and, crucially, do not send the emails a second time. Nor
      // promise one: this call sent nothing and cannot tell whether the first
      // attempt's confirmation went or was held back by a cap (#52), so the
      // page points at its own button instead.
      if (error.code === UNIQUE_VIOLATION)
        return { ok: true as const, duplicate: true, emailed: false };
      throw new Error(error.message);
    }

    // Best-effort transactional emails: confirm to the applicant (nudging them
    // to sign their prefilled waiver next) and notify managers of the new lead.
    // Never let an email hiccup fail the registration the visitor just made.
    //
    // `emailed` is whether the applicant's confirmation went, so the next
    // screen only says "we'll email you the link" when we did (#52: a capped
    // email is held back, and a failed one never arrives either).
    let emailed = false;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { sendInterestEmails } = await import("@/lib/interest-email.server");
      const result = await sendInterestEmails({
        // Unique per submission: keeps the email provider's idempotency keys
        // distinct across separate registrations (the anon insert can't return
        // a row id, and this table has no natural key — leads are unlimited).
        // Prefer the client's submission id when there is one, so a retry that
        // slips past the unique index still lands on the same idempotency key.
        registrationId: submissionId ?? crypto.randomUUID(),
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        message: data.message || null,
        admin: supabaseAdmin,
      });
      emailed = result.applicantEmailed;
    } catch (e) {
      console.error("[submitInterest] failed to send interest emails:", e);
    }

    return { ok: true as const, duplicate: false, emailed };
  });

export const submitContact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => contactSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, duplicate: false };
    const submissionId = data.client_submission_id || null;
    await limit("contact", submissionId);
    const supabase = serverSupabase();

    const { error } = await supabase.from("contact_messages").insert({
      name: data.name,
      email: data.email,
      subject: data.subject || null,
      message: data.message,
      client_submission_id: submissionId,
    });
    if (error) {
      // This exact message is already filed. Report success (it IS recorded)
      // and, crucially, do not send the emails a second time.
      if (error.code === UNIQUE_VIOLATION) return { ok: true as const, duplicate: true };
      throw new Error(error.message);
    }

    // Best-effort transactional emails: acknowledge the sender and put the
    // message itself in front of every manager. Until this existed the row was
    // the only trace of a message and nothing on the site read that table, so a
    // contact form submission reached nobody at all. Never let an email hiccup
    // fail the message the visitor just sent.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { sendContactEmails } = await import("@/lib/contact-email.server");
      await sendContactEmails({
        // Same reasoning as submitInterest: the anon insert cannot return a row
        // id and this table has no natural key, so prefer the client's
        // submission id (a retry that slips past the unique index then lands on
        // the same idempotency key) and fall back to a fresh one.
        messageId: submissionId ?? crypto.randomUUID(),
        name: data.name,
        email: data.email,
        subject: data.subject || null,
        message: data.message,
        admin: supabaseAdmin,
      });
    } catch (e) {
      console.error("[submitContact] failed to send contact emails:", e);
    }

    return { ok: true as const, duplicate: false };
  });
