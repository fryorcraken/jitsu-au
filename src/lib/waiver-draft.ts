// Keeping a half-filled waiver so nobody has to type it twice.
//
// The waiver is around twenty fields plus five health answers, a set of
// acknowledgements and a hand-drawn signature. Before this, a reload, a crashed
// mobile tab, or a phone backgrounding the page long enough to be evicted lost
// all of it, and nobody fills that in a second time. A person who gives up at
// that point is a person who never signs.
//
// **sessionStorage, deliberately, not localStorage.** The draft carries health
// answers, medical notes and a signature image. Those survive a reload and a
// crash, which is what the problem needs, and they are gone when the browser
// closes, so nothing sensitive is left behind on a shared or borrowed machine.
//
// It also carries the submission id, which matters more than it looks: reloading
// mid-submit reuses the same id, so the page can ask "did that one land?"
// instead of sending a second signed waiver.
//
// Keep this file free of side effects and of any server-only or React
// dependency so it stays unit-testable, mirroring `auth-persistence.ts`. The
// pure serialize/parse half is separated from the storage half for the same
// reason.

import type { HealthAnswers, HealthQuestionId } from "@/lib/validation";

export const WAIVER_DRAFT_KEY = "uts-jitsu.waiver.draft";

/**
 * Bumped whenever the draft shape changes. A stored draft written by an older
 * version is discarded rather than half-restored, which would silently drop
 * whichever fields were renamed and leave the person unaware.
 */
export const WAIVER_DRAFT_VERSION = 1;

/**
 * Roughly how much we are willing to keep. sessionStorage quotas sit around
 * 5 MB per origin, and two signature PNGs can be 500 KB each, so this is not
 * close to the limit in practice. It is a guard against the one case that would
 * throw: an unusually large drawn signature on a high-DPI tablet.
 */
export const WAIVER_DRAFT_MAX_BYTES = 2_000_000;

/** Health answers mid-fill: `null` means "not answered yet". */
export type HealthDraft = Record<HealthQuestionId, boolean | null>;

export type WaiverDraft = {
  submissionId: string;
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  dob: string;
  phone: string;
  email: string;
  address: string;
  utsStudentNumber: string;
  smsConsent: boolean;
  /** A gi size code, or "" for not chosen. Optional on the form, so "" is normal. */
  giSize: string;
  ecName: string;
  ecRelationship: string;
  ecPhone: string;
  health: HealthDraft;
  medical: string;
  acks: Record<string, boolean>;
  signatureMode: "draw" | "type";
  signatureName: string;
  signatureImage: string;
  guardianSignatureMode: "draw" | "type";
  guardianSignature: string;
  guardianSignatureImage: string;
};

type StoredDraft = WaiverDraft & { version: number };

/**
 * Serialise a draft, dropping the signature images if the result is too large.
 *
 * Dropping them is the right trade: a signature takes seconds to redraw, and the
 * twenty fields around it do not. Throwing a QuotaExceededError instead would
 * lose the lot, and it would do it inside a keystroke handler.
 */
export function serializeDraft(draft: WaiverDraft): string {
  const full = JSON.stringify({ ...draft, version: WAIVER_DRAFT_VERSION } satisfies StoredDraft);
  if (full.length <= WAIVER_DRAFT_MAX_BYTES) return full;
  return JSON.stringify({
    ...draft,
    signatureImage: "",
    guardianSignatureImage: "",
    version: WAIVER_DRAFT_VERSION,
  } satisfies StoredDraft);
}

/**
 * Read a stored draft back, or null if there isn't a usable one.
 *
 * Never throws: a malformed or stale draft is simply not a draft. The caller is
 * a page load, and a page that will not render because of leftover storage is
 * worse than one that starts with an empty form.
 */
export function parseDraft(raw: string | null): WaiverDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const draft = parsed as Partial<StoredDraft>;
  if (draft.version !== WAIVER_DRAFT_VERSION) return null;
  if (typeof draft.submissionId !== "string" || !draft.submissionId) return null;

  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const mode = (v: unknown): "draw" | "type" => (v === "type" ? "type" : "draw");
  const health = (v: unknown): HealthDraft => {
    const source = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const out: Record<string, boolean | null> = {};
    for (const [key, value] of Object.entries(source)) {
      out[key] = typeof value === "boolean" ? value : null;
    }
    return out as HealthDraft;
  };
  const acks = (v: unknown): Record<string, boolean> => {
    const source = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  };

  return {
    submissionId: draft.submissionId,
    firstName: text(draft.firstName),
    middleName: text(draft.middleName),
    lastName: text(draft.lastName),
    preferredName: text(draft.preferredName),
    dob: text(draft.dob),
    phone: text(draft.phone),
    email: text(draft.email),
    address: text(draft.address),
    utsStudentNumber: text(draft.utsStudentNumber),
    smsConsent: draft.smsConsent === true,
    // Deliberately does NOT bump WAIVER_DRAFT_VERSION: `giSize` is a new
    // optional field, and a draft written before it existed restores with "",
    // which is exactly what "did not choose one" means. The version bump is for
    // renames and removals, where a silent half-restore would lose something.
    // Bumping here would bin every half-filled waiver, signature included, over
    // a field nobody had filled in.
    giSize: text(draft.giSize),
    ecName: text(draft.ecName),
    ecRelationship: text(draft.ecRelationship),
    ecPhone: text(draft.ecPhone),
    health: health(draft.health),
    medical: text(draft.medical),
    acks: acks(draft.acks),
    signatureMode: mode(draft.signatureMode),
    signatureName: text(draft.signatureName),
    signatureImage: text(draft.signatureImage),
    guardianSignatureMode: mode(draft.guardianSignatureMode),
    guardianSignature: text(draft.guardianSignature),
    guardianSignatureImage: text(draft.guardianSignatureImage),
  };
}

/**
 * Whether a draft holds enough to be worth offering back.
 *
 * A draft is written as soon as the page mounts (it always carries a submission
 * id), so "there is a draft" is not the same as "they had started". Offering to
 * restore an empty form would just be noise on a first visit.
 */
export function draftHasContent(draft: WaiverDraft | null): boolean {
  if (!draft) return false;
  const filledText = [
    draft.firstName,
    draft.lastName,
    draft.dob,
    draft.phone,
    draft.address,
    draft.ecName,
    draft.ecPhone,
    draft.medical,
    draft.signatureName,
    draft.signatureImage,
  ].some((v) => v.trim() !== "");
  const answeredHealth = Object.values(draft.health).some((v) => v !== null);
  return filledText || answeredHealth;
}

/* ---- Storage, guarded for SSR and for browsers that refuse it ---- */

function storage(): Storage | null {
  // Not just an SSR guard: Safari in private mode and locked-down enterprise
  // profiles throw on access rather than returning null.
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readDraft(): WaiverDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    return parseDraft(store.getItem(WAIVER_DRAFT_KEY));
  } catch {
    return null;
  }
}

export function writeDraft(draft: WaiverDraft): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WAIVER_DRAFT_KEY, serializeDraft(draft));
  } catch {
    /* out of quota or storage disabled: the form still works, it just won't survive a reload */
  }
}

export function clearDraft(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(WAIVER_DRAFT_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Convenience for tests and callers building a draft from empty state. */
export function emptyHealthDraft(ids: readonly HealthQuestionId[]): HealthDraft {
  return Object.fromEntries(ids.map((id) => [id, null])) as HealthDraft;
}

/** Narrow a finished draft's health answers to the five booleans the server wants. */
export function isCompleteHealth(health: HealthDraft): health is HealthAnswers {
  return Object.values(health).every((v) => typeof v === "boolean");
}
