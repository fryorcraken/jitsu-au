// Server functions for the code of conduct: who is signing, and recording it.
//
// The document itself and every pure rule live in `code-of-conduct.ts`; this
// file is the plumbing. Two things here are worth reading before changing
// anything:
//
//   * **Nobody types who they are.** The name and email stored on an acceptance
//     are read from the person's profile and login by the server. The form
//     collects agreement and a signature, nothing else, so there is no way to
//     agree on somebody else's behalf by typing their address.
//   * **Signing is offered to people who cannot log in.** The moment the club
//     most wants this signed is straight after a waiver, and at that point the
//     person is a locked applicant: their login is banned until a manager
//     approves them. So identity comes from either a session OR the emailed
//     token, and a page with neither can only be read.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import {
  buildSignerMeta,
  codeOfConductAcceptSchema,
  greetingName,
  normalizeEmail,
  profileFullName,
} from "@/lib/validation";
import type { SignerMeta } from "@/lib/validation";
import { CODE_OF_CONDUCT_VERSION, codeOfConductState } from "@/lib/code-of-conduct";
import type { CodeOfConductState } from "@/lib/code-of-conduct";

type AdminClient = SupabaseClient<Database>;

/**
 * Best-effort real client IP from the proxy headers, kept on the acceptance as
 * the same forensic record a waiver keeps. Mirrors `clientIp` in
 * `waiver.functions.ts`.
 */
function clientIp(getHeader: (name: string) => string | undefined): string | null {
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return getHeader("cf-connecting-ip") || getHeader("x-real-ip") || null;
}

/** Request headers, when the server runtime exposes them. Never throws. */
async function headerGetter(): Promise<(name: string) => string | undefined> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return (name: string) => getRequestHeader(name);
  } catch {
    return () => undefined;
  }
}

/** The person a signing session belongs to, resolved server-side. */
export type CodeOfConductSigner = {
  userId: string;
  /** Legal name, as the club currently records it. Stored on the acceptance. */
  fullName: string;
  /** What to call them on screen: preferred name, else first name. */
  greetingName: string;
  email: string;
  /** True when a session identified them (rather than an emailed token). */
  signedIn: boolean;
};

/**
 * Who is signing, from a session if there is one, otherwise from the emailed
 * token. Returns null when neither identifies anybody.
 *
 * A session wins over a token on purpose, and it is the same rule the waiver
 * applies: a signed-in person signs for themselves. Someone who opens a
 * friend's link while logged in signs their own agreement, not their friend's.
 */
async function resolveSigner(
  admin: AdminClient,
  token: string | undefined,
): Promise<CodeOfConductSigner | null> {
  const getHeader = await headerGetter();
  const bearer = getHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;

  let userId: string | null = null;
  let email: string | null = null;
  let signedIn = false;

  if (bearer) {
    try {
      const { data } = await admin.auth.getUser(bearer);
      if (data.user?.email) {
        userId = data.user.id;
        email = data.user.email;
        signedIn = true;
      }
    } catch {
      // An expired token just means "not signed in"; fall through to the link.
    }
  }

  const raw = (token || "").trim();
  if (!userId && raw) {
    const { lookupVerificationToken } = await import("@/lib/email-verification.server");
    const { tokenProvesEmail } = await import("@/lib/email-verification");
    // The only token this page is ever linked with. Scoped so an interest or
    // waiver token cannot be spent here either.
    const found = await lookupVerificationToken(admin, raw, {
      purposes: ["code_of_conduct"],
    });
    if (found) {
      // A lead's token carries no user id, so re-resolve the address. Signing
      // the code of conduct never CREATES a person: someone whose address the
      // club does not hold has nothing to attach an agreement to.
      let tokenUserId = found.user_id;
      if (!tokenUserId) {
        const { userIdByEmail } = await import("@/lib/supabase-rpc");
        const { data: resolved } = await userIdByEmail(admin, normalizeEmail(found.email));
        tokenUserId = resolved ?? null;
      }
      if (tokenUserId) {
        const { data: got } = await admin.auth.admin.getUserById(tokenUserId);
        // The guard the token design rests on: a link proves the address it was
        // mailed to and nothing else. If the account's address has moved on
        // since, this link is inert.
        if (got?.user?.email && tokenProvesEmail(found.email, got.user.email)) {
          userId = tokenUserId;
          email = got.user.email;
          // Best-effort, like every other redemption stamp on this table: a
          // PostgrestBuilder is a lazy thenable, so the .then() is what issues
          // the request and a failure here must not block signing.
          admin
            .from("email_verification_tokens")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", found.id)
            .then(
              () => {},
              () => {},
            );
        }
      }
    }
  }

  if (!userId || !email) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("first_name, middle_name, last_name, preferred_name")
    .eq("user_id", userId)
    .maybeSingle();

  // No profile means no person row to hang an acceptance off (the foreign key
  // points at `profiles`), so treat it as "we don't know who you are" rather
  // than letting the insert fail later with a constraint error.
  if (!profile) return null;

  return {
    userId,
    fullName: profileFullName(profile) || email,
    greetingName: greetingName(profile) || email,
    email,
    signedIn,
  };
}

/** One recorded agreement, as the member and manager screens show it. */
export type CodeOfConductAcceptanceView = {
  id: string;
  version: number;
  accepted_at: string;
  signature_name: string;
};

async function listAcceptances(
  admin: AdminClient,
  userId: string,
): Promise<CodeOfConductAcceptanceView[]> {
  const { data, error } = await admin
    .from("code_of_conduct_acceptances")
    .select("id, version, accepted_at, signature_name")
    .eq("user_id", userId)
    .order("accepted_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * The highest version a person has agreed to, and the state that follows from
 * it. Exported because both the member's account page and the manager's person
 * page need the same answer and must not derive it two different ways.
 */
export async function codeOfConductStatusFor(
  admin: AdminClient,
  userId: string,
): Promise<{
  state: CodeOfConductState;
  version: number;
  accepted_version: number | null;
  accepted_at: string | null;
  acceptances: CodeOfConductAcceptanceView[];
}> {
  const acceptances = await listAcceptances(admin, userId);
  // Newest FIRST by date, but the state is about the highest VERSION agreed to:
  // re-signing an old version after a new one would otherwise read as a
  // downgrade, and the club has no reason to treat it as one.
  const best = acceptances.reduce<CodeOfConductAcceptanceView | null>(
    (top, a) => (!top || a.version > top.version ? a : top),
    null,
  );
  return {
    state: codeOfConductState(best?.version ?? null),
    version: CODE_OF_CONDUCT_VERSION,
    accepted_version: best?.version ?? null,
    accepted_at: best?.accepted_at ?? null,
    acceptances,
  };
}

/**
 * Who the signing form should address, and whether they have already agreed.
 *
 * Public: it is called by anyone opening `/code-of-conduct`, with or without a
 * link. It never reveals anything about an address that was not supplied as a
 * live token, so it cannot be used to probe who the club holds.
 */
export const getCodeOfConductSigner = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ token: z.string().trim().max(120).optional().or(z.literal("")) }).parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const signer = await resolveSigner(supabaseAdmin, data.token);
    if (!signer) {
      return { signer: null, version: CODE_OF_CONDUCT_VERSION, status: null };
    }
    const status = await codeOfConductStatusFor(supabaseAdmin, signer.userId);
    return {
      signer: {
        name: signer.greetingName,
        full_name: signer.fullName,
        email: signer.email,
        signed_in: signer.signedIn,
      },
      version: CODE_OF_CONDUCT_VERSION,
      status,
    };
  });

/**
 * Record an agreement to the code of conduct.
 *
 * Re-signing is always allowed, exactly as re-submitting a waiver is: a new
 * version, a change of heart about the name they signed with, or simply a
 * second click all just add a row. Nothing is ever overwritten, so the history
 * of what somebody agreed to and when stays intact.
 */
export const acceptCodeOfConduct = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => codeOfConductAcceptSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, accepted_at: null };

    // Refuse to file an agreement against text we cannot identify. The page
    // holds its version for the life of the tab, so a deploy that changes the
    // document mid-read would otherwise record agreement to wording the person
    // never saw. Same rule the waiver applies to its template version.
    if (data.version !== CODE_OF_CONDUCT_VERSION) {
      throw new Error(
        "The code of conduct was updated while you had this page open. Please reload and read the current version before signing.",
      );
    }

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const signer = await resolveSigner(admin, data.token);
    if (!signer) {
      throw new Error(
        "We couldn't tell who you are. Open the link from your email, or sign in to your account, then try again.",
      );
    }

    const getHeader = await headerGetter();
    const signer_ip = clientIp(getHeader);
    const signer_meta: SignerMeta = buildSignerMeta(getHeader, data.client_meta);

    const accepted_at = new Date().toISOString();
    const { error } = await admin.from("code_of_conduct_acceptances").insert({
      user_id: signer.userId,
      version: data.version,
      accepted_at,
      full_name: signer.fullName,
      email: signer.email,
      signature_name: data.signature_name,
      signer_ip,
      signer_meta,
    });
    if (error) throw new Error(error.message);

    // Signing does NOT confirm the email address, even though arriving here from
    // a link looks like proof. The code-of-conduct token is handed back by
    // `submitWaiverWithPdf` in its HTTP response so the button works straight
    // after signing a waiver, and waiver signing is public — so anyone could
    // mint one for any address and spend it here. See `mailboxProvingPurposes`.
    // The waiver confirmation email carries its own "confirm your email address"
    // button, which only ever exists inside that email, and that one does.

    return { ok: true as const, accepted_at };
  });
