import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
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
    const { error } = await supabase.from("interest_registrations").insert(interestRow as never);
    if (error) throw new Error(error.message);
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

const waiverSchema = z.object({
  full_name: z.string().trim().min(1).max(120),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.string().trim().min(1).max(300),
  phone: z.string().trim().min(1).max(30),
  email: z.string().trim().email().max(255),
  emergency_contact_name: z.string().trim().min(1).max(120),
  emergency_contact_phone: z.string().trim().min(1).max(30),
  medical_notes: z.string().trim().max(2000).optional().or(z.literal("")),
  ack_risk: z.literal(true),
  ack_release: z.literal(true),
  ack_media: z.boolean(),
  signature_name: z.string().trim().min(1).max(120),
  hp: z.string().max(0).optional(),
});

export const submitWaiver = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => waiverSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true };
    const supabase = serverSupabase();
    const { error } = await supabase.from("waivers").insert({
      full_name: data.full_name,
      date_of_birth: data.date_of_birth,
      address: data.address,
      phone: data.phone,
      email: data.email,
      emergency_contact_name: data.emergency_contact_name,
      emergency_contact_phone: data.emergency_contact_phone,
      medical_notes: data.medical_notes || null,
      acknowledgements: {
        risk: data.ack_risk,
        release: data.ack_release,
        media: data.ack_media,
      },
      signature_name: data.signature_name,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
