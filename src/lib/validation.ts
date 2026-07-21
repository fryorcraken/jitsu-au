// Shared validation schemas and pure helpers for form submissions.
//
// These live here (rather than inline in the *.functions.ts server modules) so
// they can be unit-tested directly and reused by both client and server without
// pulling in server-only imports. Keep this file free of side effects and of any
// server-only dependency (no supabase clients, no process.env reads).
import { z } from "zod";

// ---- Pure helpers ----

/** Join first/middle/last into a single display name, trimming and dropping blanks. */
export function composeFullName(first: string, middle: string, last: string): string {
  return [first, middle, last]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes.
 * Returns null for empty input or anything that isn't a base64 PNG data URL.
 */
export function decodeDataUrlPng(dataUrl: string): Uint8Array | null {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const binary = atob(m[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ---- Interest registration ----

export const interestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  uts_student: z.boolean(),
  experience: z.string().trim().max(500).optional().or(z.literal("")),
  message: z.string().trim().max(1000).optional().or(z.literal("")),
  hp: z.string().max(0).optional(), // honeypot — must stay empty
});

// ---- Contact message ----

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  subject: z.string().trim().max(150).optional().or(z.literal("")),
  message: z.string().trim().min(1).max(2000),
  hp: z.string().max(0).optional(), // honeypot
});

// ---- Waiver submission (name-split + signature + minor guardian) ----

const sigImage = z.string().max(500_000).optional().or(z.literal(""));

export const waiverSubmitSchema = z
  .object({
    first_name: z.string().trim().min(1).max(60),
    middle_name: z.string().trim().max(60).optional().or(z.literal("")),
    last_name: z.string().trim().min(1).max(60),
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
    signature_name: z.string().trim().max(120).optional().or(z.literal("")),
    signature_image: sigImage,
    is_minor: z.boolean().optional().default(false),
    guardian_name: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    guardian_signature: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_signature_image: sigImage,
    hp: z.string().max(0).optional(),
  })
  .refine(
    (d) =>
      Boolean(
        (d.signature_name && d.signature_name.trim()) ||
        (d.signature_image && d.signature_image.trim()),
      ),
    { message: "A signature is required — draw or type your name.", path: ["signature_name"] },
  )
  .refine(
    (d) =>
      !d.is_minor ||
      (d.guardian_name &&
        d.guardian_relationship &&
        ((d.guardian_signature && d.guardian_signature.trim()) ||
          (d.guardian_signature_image && d.guardian_signature_image.trim()))),
    {
      message:
        "Parent/guardian name, relationship and signature are required for participants under 18.",
      path: ["guardian_name"],
    },
  );

export type WaiverSubmitInput = z.infer<typeof waiverSubmitSchema>;

// ---- Manager: save waiver template ----

export const saveTemplateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body_md: z.string().trim().min(1).max(30000),
});
