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

export const submitInterest = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => interestSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true };
    const supabase = serverSupabase();
    // Providing a phone number here is implicit consent to SMS/WhatsApp contact
    // (the phone field carries a consent note). Record it so later forms can
    // prefill their consent checkbox. Built as a variable + cast so the
    // `sms_whatsapp_consent` key (absent from the stale generated Insert type)
    // doesn't trip the excess-property check.
    const interestRow = {
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      sms_whatsapp_consent: Boolean(data.phone && data.phone.trim()),
      experience: data.experience || null,
      message: data.message || null,
    };
    // A registration is a LEAD: just this row, nothing else. The person record
    // (locked login + profile) starts later, when they sign the waiver.
    const { data: inserted, error } = await supabase
      .from("interest_registrations")
      .insert(interestRow as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Best-effort transactional emails: confirm to the applicant (nudging them
    // to sign their prefilled waiver next) and notify managers of the new lead.
    // Never let an email hiccup fail the registration the visitor just made.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { sendInterestEmails } = await import("@/lib/interest-email.server");
      await sendInterestEmails({
        registrationId: (inserted as { id: string }).id,
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

    return { ok: true };
  });

export const submitContact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => contactSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true };
    const supabase = serverSupabase();
    const { error } = await supabase.from("contact_messages").insert({
      name: data.name,
      email: data.email,
      subject: data.subject || null,
      message: data.message,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
