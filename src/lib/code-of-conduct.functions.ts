// Server functions for the code of conduct: the document's versions, who is
// signing, and recording it.
//
// The document lives in `code_of_conduct_versions`, one row per saved version,
// one live; every pure rule lives in `code-of-conduct.ts`. This file is the
// plumbing. Three things here are worth reading before changing anything:
//
//   * **An acceptance names the version whose text was SHOWN.** The page sends
//     the number it rendered, and signing refuses one that is no longer live,
//     rather than recording "whatever is live at submit". A manager publishing
//     while somebody reads would otherwise file their agreement against words
//     they never saw.
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
  nameWithPreferred,
  normalizeEmail,
  profileFullName,
} from "@/lib/validation";
import type { SignerMeta } from "@/lib/validation";
import { householdTargetUserId, resolveSubject } from "@/lib/household";
import {
  codeOfConductStandard,
  codeOfConductSummary,
  isSignableVersion,
  requiredVersionForSave,
  type CodeOfConductStandard,
  type CodeOfConductVersionFlags,
  type CodeOfConductState,
} from "@/lib/code-of-conduct";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireManager } from "@/lib/require-manager";
import {
  saveCodeOfConductSchema,
  setCurrentTemplateSchema,
  type SaveCodeOfConductInput,
} from "@/lib/validation";
import { DocumentVersionError } from "@/lib/document-versions";
import {
  nextDocumentVersion,
  promoteDocumentVersion,
  type VersionedDocument,
} from "@/lib/document-version-store";

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
 * What the club currently asks of everybody: the live version, and the version
 * it requires people to have agreed to (`codeOfConductStandard`).
 *
 * Exported because every surface that reports where somebody stands measures
 * against it: the member's screens through `codeOfConductStatusFor`, the
 * manager person page, and the manager agent API.
 */
export async function loadCodeOfConductStandard(
  admin: AdminClient,
): Promise<CodeOfConductStandard> {
  return codeOfConductStandard(await listCodeOfConductVersionFlags(admin));
}

/**
 * The facts of every stored version that decide who is out of date, without
 * the text: what counting the effect of a save or a rollback needs, at a
 * fraction of the size of every version's body.
 */
export async function listCodeOfConductVersionFlags(
  admin: AdminClient,
): Promise<CodeOfConductVersionFlags[]> {
  const { data, error } = await admin
    .from("code_of_conduct_versions")
    .select("version, asks_reagreement, required_version, is_current");
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
  version: number | null;
  accepted_version: number | null;
  accepted_at: string | null;
  acceptances: CodeOfConductAcceptanceView[];
}> {
  const [acceptances, standard] = await Promise.all([
    listAcceptances(admin, userId),
    loadCodeOfConductStandard(admin),
  ]);
  const summary = codeOfConductSummary(acceptances, standard);
  return {
    state: summary.state,
    version: standard.current_version,
    accepted_version: summary.accepted_version,
    accepted_at: summary.accepted_at,
    acceptances,
  };
}

/**
 * Whose standing `getCodeOfConductSigner` should report: the signer themselves,
 * or a dependant of theirs.
 *
 * Its own function, and exported, because a `createServerFn` handler cannot be
 * called from the runner (no Start context), and the rule below is the single
 * line stopping an emailed link from reading a household. See
 * `contact-messages.functions.ts` for the same reason spelled out.
 */
export async function codeOfConductSubject(
  admin: AdminClient,
  signer: Pick<CodeOfConductSigner, "userId" | "signedIn">,
  target: string | undefined,
): Promise<string> {
  if (!target) return signer.userId;
  // The ONE extra rule this path has: reaching past yourself needs a live
  // session, never an emailed link. Signing a waiver is public and hands back a
  // code-of-conduct token, so anyone can mint one for any address (see the note
  // at the foot of `acceptCodeOfConduct`). A token proves an address; it must
  // never prove the right to read a household.
  //
  // The comparison is only here to decide whether THAT rule applies, not to
  // decide whether the caller is allowed. Naming yourself has to stay allowed
  // for a link-identified caller (it is the ordinary /code-of-conduct case),
  // but `assertActingFor` is still the one place that says so: this function
  // must not grow a second opinion about who may act for whom.
  if (!signer.signedIn && target.toLowerCase() !== signer.userId.toLowerCase()) {
    throw new Error("Sign in to your account to see this.");
  }
  return resolveSubject(admin, signer.userId, target);
}

/**
 * Who the signing form should address, and whether they have already agreed.
 *
 * Public: it is called by anyone opening `/code-of-conduct`, with or without a
 * link. It never reveals anything about an address that was not supplied as a
 * live token, so it cannot be used to probe who the club holds.
 *
 * `userId` asks for somebody else's standing instead: a dependant of the
 * caller's, checked by `assertActingFor`. `signer` still describes the CALLER,
 * because they are the person who would sign, and only `status` moves. ⚠️ That
 * makes one response object about two people, so anything added to `signer`
 * later is about the caller and must not be rendered as the subject's.
 */
export const getCodeOfConductSigner = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        token: z.string().trim().max(120).optional().or(z.literal("")),
        userId: householdTargetUserId.optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const signer = await resolveSigner(supabaseAdmin, data.token);
    if (!signer) {
      return { signer: null, status: null };
    }
    const subjectId = await codeOfConductSubject(supabaseAdmin, signer, data.userId);
    const status = await codeOfConductStatusFor(supabaseAdmin, subjectId);
    // WHO the agreement would be about, when that is not the caller. Null for
    // the ordinary case, so a page can tell the two apart without comparing
    // ids. The screen needs this: "Signing as Ada Lovelace" above a form that
    // files an agreement for Bea would be a true sentence about the wrong
    // thing, and the parent would have no way to tell which child they are
    // agreeing for.
    const subject =
      subjectId.toLowerCase() === signer.userId.toLowerCase()
        ? null
        : await subjectNameFor(supabaseAdmin, subjectId);
    return {
      signer: {
        name: signer.greetingName,
        full_name: signer.fullName,
        email: signer.email,
        signed_in: signer.signedIn,
      },
      subject,
      status,
    };
  });

/**
 * The name to print for a dependant the caller is signing for.
 *
 * Only ever called after `codeOfConductSubject` has allowed the target, so this
 * reads a person the caller is already entitled to see. A missing profile row
 * yields a null name rather than throwing: the page can say "for this person"
 * and still work, and failing the whole read over a display name would take
 * down a form that has nothing wrong with it.
 */
async function subjectNameFor(
  admin: AdminClient,
  userId: string,
): Promise<{ user_id: string; name: string | null; greeting_name: string | null }> {
  const { data, error } = await admin
    .from("profiles")
    .select("first_name, middle_name, last_name, preferred_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.error("[getCodeOfConductSigner] subject name lookup failed:", error);
  return {
    user_id: userId,
    name: data ? nameWithPreferred(data) || null : null,
    greeting_name: data ? greetingName(data) || null : null,
  };
}

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

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");

    // Refuse to file an agreement against text the person did not see. The page
    // sends the version it rendered and holds it for the life of the tab, so a
    // manager publishing mid-read would otherwise record agreement to wording
    // the person never saw. Same rule the waiver applies to its template version.
    if (!isSignableVersion(data.version, await loadCodeOfConductStandard(admin))) {
      throw new Error(
        "The code of conduct was updated while you had this page open. Please reload and read the current version before signing.",
      );
    }

    const signer = await resolveSigner(admin, data.token);
    if (!signer) {
      throw new Error(
        "We couldn't tell who you are. Open the link from your email, or sign in to your account, then try again.",
      );
    }

    const getHeader = await headerGetter();
    const signer_ip = clientIp(getHeader);
    const signer_meta: SignerMeta = buildSignerMeta(getHeader, data.client_meta);

    // WHOSE agreement this is. `codeOfConductSubject` is the same gate the read
    // above goes through, including the extra rule that reaching past yourself
    // needs a live session: a token proves an address, and it must never prove
    // the right to write into a household.
    //
    // #111 left this deliberately undone and said why. A child's waiver mints
    // no code-of-conduct link, because the token identifies its holder by
    // proving an address and `resolveSigner` re-checks that the token's person
    // still has that address -- a token minted for a child could never be
    // opened by the parent it was posted to, and minting it against the parent
    // instead would have them agree for themselves while the child never does.
    // This is the route #111 named as the answer: a parent signs it for their
    // child from the member area, where there is a session to check.
    const subjectId = await codeOfConductSubject(admin, signer, data.userId);
    const forDependant = subjectId.toLowerCase() !== signer.userId.toLowerCase();

    const accepted_at = new Date().toISOString();
    const { error } = await admin.from("code_of_conduct_acceptances").insert({
      // The row is ABOUT the person who is bound by it.
      user_id: subjectId,
      version: data.version,
      accepted_at,
      // ...but `full_name`, `email` and `signature_name` record who actually
      // AGREED, and for a child that is the parent. Deliberate, and the same
      // reading `media_consent_updated_by` takes: this is evidence of an act,
      // and the act was the parent's. Filing it under the child's name would
      // record a nine-year-old as having signed something they cannot sign,
      // and under an address that reaches nobody.
      full_name: signer.fullName,
      email: signer.email,
      signature_name: data.signature_name,
      signer_ip,
      signer_meta: forDependant ? { ...signer_meta, on_behalf_of: subjectId } : signer_meta,
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

// ---- The document's versions ----

/** The code of conduct, as the shared version store talks about it. */
const CODE_OF_CONDUCT_DOCUMENT: VersionedDocument = {
  table: "code_of_conduct_versions",
  noun: "code of conduct",
  withoutOne: "nobody can read it or agree to it",
};

/**
 * One stored version, as every manager surface reads it. The editor screen and
 * the manager agent API project the same row through the same functions, so a
 * version an agent reads back is the version a manager sees on screen.
 */
export type CodeOfConductVersion = {
  id: string;
  version: number;
  title: string;
  body_md: string;
  asks_reagreement: boolean;
  required_version: number;
  is_current: boolean;
  created_at: string;
};

const VERSION_COLUMNS =
  "id, version, title, body_md, asks_reagreement, required_version, is_current, created_at";

/** Every stored version, newest first. */
export async function listCodeOfConductVersionRows(
  admin: AdminClient,
): Promise<CodeOfConductVersion[]> {
  const { data, error } = await admin
    .from("code_of_conduct_versions")
    .select(VERSION_COLUMNS)
    .order("version", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * One stored version, or the live one when no version is named. "The live one"
 * is the row flagged `is_current`, never the highest-numbered: those differ the
 * moment a manager rolls back, and answering with the newest would have a
 * caller edit and republish over the version the club deliberately went back to.
 */
export async function loadCodeOfConductVersion(
  admin: AdminClient,
  version?: number,
): Promise<CodeOfConductVersion | null> {
  const query = admin.from("code_of_conduct_versions").select(VERSION_COLUMNS);
  const { data, error } = await (
    version === undefined ? query.eq("is_current", true) : query.eq("version", version)
  ).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Each person's highest agreed version, one number per person: what the editor
 * needs to say how many people a publish would ask to agree again. Numbers only,
 * no ids, because that count is all it is for.
 *
 * Paged, because PostgREST caps a single response (1000 rows by default) without
 * an error, and a capped read here would quietly undercount.
 */
export async function highestAcceptedVersions(admin: AdminClient): Promise<number[]> {
  const PAGE = 1000;
  const highest = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("code_of_conduct_acceptances")
      .select("user_id, version")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const a of data ?? [])
      highest.set(a.user_id, Math.max(highest.get(a.user_id) ?? 0, a.version));
    if (!data || data.length < PAGE) break;
  }
  return [...highest.values()];
}

/** Make one stored version the live one. There is no content rule to check. */
export async function promoteCodeOfConductVersion(
  admin: AdminClient,
  id: string,
): Promise<{ version: number }> {
  return promoteDocumentVersion(admin, CODE_OF_CONDUCT_DOCUMENT, id);
}

/**
 * Write a new version and make it the live one: the whole of "save", as the
 * editor screen and the manager agent API both mean it.
 *
 * Every save gets its own number, including a typo fix, so an acceptance's
 * number always names the exact text that person read. Whether the save asks
 * everybody to agree again is `asks_reagreement`, recorded on the row.
 *
 * Written as a draft and THEN promoted, for the reason `saveWaiverTemplateVersion`
 * gives: a failed insert changes nothing, and a failed promotion leaves the
 * previous version live rather than leaving the club with none.
 *
 * `client_submission_id` makes a retry safe: the same id comes back as the
 * version it already wrote (`already_saved`), never as a second one.
 */
export async function saveCodeOfConductVersion(
  admin: AdminClient,
  input: SaveCodeOfConductInput,
  createdBy: string | null,
): Promise<{ id: string; version: number; is_current: boolean; already_saved: boolean }> {
  // What an earlier attempt of this same save already wrote, if anything.
  //
  // Refused when the id comes back with different words: reusing an id for a
  // different save would otherwise drop the new text and report success. And
  // finished when it never went live: the first attempt wrote the version and
  // then lost the promotion (`not_published`), and this retry is the caller
  // asking for that save, so it is promoted now rather than reported as done.
  const replay = async () => {
    if (!input.client_submission_id) return null;
    const { data, error } = await admin
      .from("code_of_conduct_versions")
      .select("id, version, title, body_md, asks_reagreement, is_current")
      .eq("client_submission_id", input.client_submission_id)
      .maybeSingle();
    if (error) throw new DocumentVersionError(error.message, "not_published");
    if (!data) return null;
    if (
      data.title !== input.title ||
      data.body_md !== input.body_md ||
      data.asks_reagreement !== input.asks_reagreement
    ) {
      throw new DocumentVersionError(
        `That client_submission_id already saved version ${data.version} with different text. Use a new id for a new save.`,
        "invalid",
        data.version,
      );
    }
    if (!data.is_current) await promoteCodeOfConductVersion(admin, data.id);
    return { id: data.id, version: data.version, is_current: true, already_saved: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  // What the new version will require is fixed now, from what the live one
  // requires: an ask that a rollback undid must stay undone.
  let now: CodeOfConductStandard;
  try {
    now = await loadCodeOfConductStandard(admin);
  } catch (e) {
    throw new DocumentVersionError(e instanceof Error ? e.message : String(e), "not_published");
  }
  const version = await nextDocumentVersion(admin, CODE_OF_CONDUCT_DOCUMENT.table);
  const { data: created, error } = await admin
    .from("code_of_conduct_versions")
    .insert({
      version,
      title: input.title,
      body_md: input.body_md,
      asks_reagreement: input.asks_reagreement,
      required_version: requiredVersionForSave(version, input.asks_reagreement, now),
      is_current: false,
      client_submission_id: input.client_submission_id ?? null,
      created_by: createdBy,
    })
    .select("id, version")
    .single();
  if (error) {
    // Two attempts of one save racing: the other one won, and it is ours.
    const raced = await replay();
    if (raced) return raced;
    throw new DocumentVersionError(error.message, "not_published");
  }

  // The version now exists. Whatever the promotion does from here, the caller
  // has to hear about THAT rather than about a save it should repeat.
  await promoteCodeOfConductVersion(admin, created.id);
  return { id: created.id, version: created.version, is_current: true, already_saved: false };
}

// ---- The public page ----

/**
 * The live version, for `/code-of-conduct`. Public, and read on the
 * service-role client like the signer lookup above: the table holds no grant
 * for the client roles at all, so nothing about it is reachable with the
 * published anon key, and this returns only what the page prints.
 *
 * Null when nothing is live, which the page says out loud rather than
 * rendering an empty document.
 */
export const getPublishedCodeOfConduct = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const live = await loadCodeOfConductVersion(supabaseAdmin);
  return live ? { version: live.version, title: live.title, body_md: live.body_md } : null;
});

// ---- Manager: the editor ----

/**
 * Every version, plus what the editor needs to say before a publish how many
 * people it will ask to agree again (each person's highest agreed version).
 */
export const listCodeOfConductVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [versions, highestAccepted] = await Promise.all([
      listCodeOfConductVersionRows(supabaseAdmin),
      highestAcceptedVersions(supabaseAdmin),
    ]);
    return { versions, highest_accepted: highestAccepted };
  });

export const saveCodeOfConduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveCodeOfConductSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const saved = await saveCodeOfConductVersion(supabaseAdmin, data, context.userId);
    return { ok: true as const, ...saved };
  });

export const setCurrentCodeOfConduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setCurrentTemplateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { version } = await promoteCodeOfConductVersion(supabaseAdmin, data.id);
    return { ok: true as const, version };
  });
