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

export const submitInterest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => interestSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, duplicate: false };
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
      experience: data.experience || null,
      message: data.message || null,
      client_submission_id: submissionId,
    });
    if (error) {
      // This exact registration is already filed. Report success (it IS
      // recorded) and, crucially, do not send the emails a second time.
      if (error.code === UNIQUE_VIOLATION) return { ok: true as const, duplicate: true };
      throw new Error(error.message);
    }

    // Best-effort transactional emails: confirm to the applicant (nudging them
    // to sign their prefilled waiver next) and notify managers of the new lead.
    // Never let an email hiccup fail the registration the visitor just made.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { sendInterestEmails } = await import("@/lib/interest-email.server");
      await sendInterestEmails({
        // Unique per submission: keeps the email provider's idempotency keys
        // distinct across separate registrations (the anon insert can't return
        // a row id, and this table has no natural key — leads are unlimited).
        // Prefer the client's submission id when there is one, so a retry that
        // slips past the unique index still lands on the same idempotency key.
        registrationId: submissionId ?? crypto.randomUUID(),
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        experience: data.experience || null,
        message: data.message || null,
        admin: supabaseAdmin,
      });
    } catch (e) {
      console.error("[submitInterest] failed to send interest emails:", e);
    }

    return { ok: true as const, duplicate: false };
  });

export const submitContact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => contactSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, duplicate: false };
    const supabase = serverSupabase();
    const { error } = await supabase.from("contact_messages").insert({
      name: data.name,
      email: data.email,
      subject: data.subject || null,
      message: data.message,
      client_submission_id: data.client_submission_id || null,
    });
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { ok: true as const, duplicate: true };
      throw new Error(error.message);
    }
    return { ok: true as const, duplicate: false };
  });
