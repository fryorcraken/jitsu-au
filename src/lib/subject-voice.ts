// How a screen refers to the person it is about.
//
// A card rendered on somebody's own account says "you"; the same card on a
// child's page has to say their name, or a parent reads "photos or video of
// you" above their nine-year-old's consent answer. Every account card and both
// account pages share this, so the two never drift into saying it differently.
//
// Its own module, pure and server-import-free, rather than a helper beside the
// cards: `/membership` needs it too, and reaching into `DetailsCard.ts` for it
// pulled `profile.functions.ts` (and the whole auth middleware behind it) into
// a page that has no business importing either.

/** How a screen refers to the person it is about. */
export type SubjectVoice = {
  /** "you" / "Bea" */
  who: string;
  /** "your" / "Bea's" */
  whose: string;
  /** Capitalised `whose`, for the start of a sentence or a card title. */
  Whose: string;
  /** True when the screen is about the person reading it. */
  isSelf: boolean;
};

/**
 * Build the voice for a subject. `null` means the caller themselves.
 *
 * A name is expected to be a first or preferred name, so the possessive is a
 * plain `'s`: "Chris's" is the standard form even for a name ending in s, and a
 * rule that special-cased it would get "James'" wrong as often as right.
 */
export function subjectVoice(name: string | null | undefined): SubjectVoice {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { who: "you", whose: "your", Whose: "Your", isSelf: true };
  const whose = `${trimmed}'s`;
  return { who: trimmed, whose, Whose: whose, isSelf: false };
}

/**
 * The name to speak to somebody by, out of a full name.
 *
 * Household lists carry legal names ("Bea Lovelace"), and a page that says
 * "Bea Lovelace's membership" in every sentence reads like a letter from a
 * bank. `nameWithPreferred` can quote a preferred name in, so the quotes are
 * stripped off the first word rather than left in the middle of a sentence.
 */
export function firstWord(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.replace(/^"|"$/g, "") || null;
}
