import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  contactSchema,
  interestSchema,
  interestVisitorSeed,
  normalizeEmail,
} from "@/lib/validation";
import type { AppClient } from "@/lib/profile-types";

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
    const { error } = await supabase.from("interest_registrations").insert(interestRow as never);
    if (error) throw new Error(error.message);

    // Giving the club an email is the moment a person starts existing: ensure
    // a visitor for it — a LOCKED auth user (long ban, no credentials; they
    // cannot log in until a waiver of theirs is approved) plus a profile
    // seeded from this form. An existing person is left untouched. Best-effort
    // by design: a hiccup here must never lose the lead row above.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = supabaseAdmin as unknown as AppClient;
      const email = normalizeEmail(data.email);
      const { data: existingId } = await admin.rpc("user_id_by_email", { _email: email });
      if (!existingId) {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          ban_duration: "876000h", // ~100 years: a visitor, not a login
        });
        let userId = created?.user?.id ?? null;
        if (!userId) {
          // A concurrent submission may have just created the user; re-resolve.
          const { data: racedId } = await admin.rpc("user_id_by_email", { _email: email });
          userId = racedId ?? null;
          if (!userId) throw createErr ?? new Error("could not create visitor");
        } else {
          // Seed the fresh visitor profile (created by the ensure_profile
          // trigger) with the form's basics.
          await admin
            .from("profiles")
            .upsert({ user_id: userId, ...interestVisitorSeed(data) }, { onConflict: "user_id" });
        }
      }
    } catch (e) {
      console.error("[submitInterest] visitor creation failed:", e);
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
