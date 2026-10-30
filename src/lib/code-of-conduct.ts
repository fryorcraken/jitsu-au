/**
 * The club's code of conduct: the pure rules around it.
 *
 * The document itself lives in the database (`code_of_conduct_versions`), in
 * numbered versions with exactly one live, and managers edit it at
 * `/manager/code-of-conduct` or through the manager agent API, the same way
 * they edit the waiver. It used to live here, bumped by hand in a pull request;
 * version 1 in the database is that text, byte for byte, because every
 * acceptance taken before the move says `version = 1`.
 *
 * What is still here is what is not house rules: the undertaking a signer gives
 * (it names the person bound by it, which is a signing mechanism rather than
 * wording a committee edits), the small markdown subset the document is written
 * in, and the rule that decides whether somebody has agreed to it.
 *
 * Keep this module side-effect-free and free of server imports (no supabase
 * clients, no `process.env`) so it stays unit-testable, mirroring `validation.ts`
 * and `email-verification.ts`.
 */

/**
 * What somebody signing for themselves undertakes, printed above the signature.
 * Typing their name is the agreement: there is no separate tick box.
 */
export const CODE_OF_CONDUCT_ACKNOWLEDGEMENT =
  "I have read the UTS Jitsu Code of Conduct and the ActivateUTS Clubs Code of Conduct, and I agree to follow both.";

/**
 * The same undertaking, for a parent agreeing on behalf of a child.
 *
 * The undertaking has to name the person it binds. A parent signing for their
 * nine-year-old was ticking "I agree to follow both" on a form filed against
 * the CHILD: the wrong promise from the wrong person, on the one document in
 * this flow whose whole purpose is to record a promise. (The tick box itself is
 * gone; the sentence it carried is what the signature now agrees to.) `name` is a greeting
 * name, so it reads the way the rest of the page addresses them.
 */
export function codeOfConductAcknowledgementFor(name: string): string {
  return `I have read the UTS Jitsu Code of Conduct and the ActivateUTS Clubs Code of Conduct, and I agree that ${name} will follow both.`;
}

// ---- Rendering ----

export type CodeOfConductBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

/**
 * The markdown the document is written in. Deliberately a small subset, stated
 * on the editor screen so a manager knows what will render: `#` and `##`
 * headings, `- ` bullets, `**bold**`, bare `https://` links, and paragraphs
 * separated by a blank line. Anything else shows as the literal text typed.
 */
export const CODE_OF_CONDUCT_SYNTAX =
  "# Heading, ## Section, - bullet, **bold**, bare https:// links, and a blank line between paragraphs.";

/**
 * Parse the document body into blocks for rendering.
 *
 * Close to `parseWaiverBlocks`, with one addition that the waiver never needed:
 * bullet lists. The code of conduct is almost entirely rules-as-bullets, and
 * rendering them as paragraphs of literal "- " would be unreadable on a phone,
 * which is where most people will read this.
 *
 * Consecutive `- ` lines within one block become a single list. A block that
 * mixes prose and bullets keeps the prose lines as their own paragraph, so an
 * intro line like "Regular sessions:" does not have to sit in its own block.
 */
export function parseCodeOfConductBlocks(body: string): CodeOfConductBlock[] {
  const blocks: CodeOfConductBlock[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith("# ")) {
      blocks.push({ kind: "h1", text: block.slice(2).trim() });
      continue;
    }
    if (block.startsWith("## ")) {
      blocks.push({ kind: "h2", text: block.slice(3).trim() });
      continue;
    }

    let bullets: string[] = [];
    let prose: string[] = [];
    const flushBullets = () => {
      if (bullets.length) blocks.push({ kind: "ul", items: bullets });
      bullets = [];
    };
    const flushProse = () => {
      if (prose.length) blocks.push({ kind: "p", text: prose.join("\n") });
      prose = [];
    };

    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("- ")) {
        flushProse();
        bullets.push(trimmed.slice(2).trim());
      } else {
        flushBullets();
        prose.push(trimmed);
      }
    }
    flushBullets();
    flushProse();
  }
  return blocks;
}

/** A run of document text: plain, bold, or a link. */
export type CodeOfConductSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * Split a line into spans: `**bold**` runs and bare `https://` URLs.
 *
 * The URLs are written bare in the body on purpose (the ActivateUTS code is
 * quoted as a URL in the club's own wording), so they are linked here rather
 * than being marked up in the source text.
 */
export function parseCodeOfConductSpans(line: string): CodeOfConductSpan[] {
  const spans: CodeOfConductSpan[] = [];
  // Trailing punctuation is excluded from the URL so a sentence-ending full
  // stop does not become part of the href.
  const pattern = /(\*\*.+?\*\*)|(https?:\/\/[^\s<>()]*[^\s<>().,;:])/g;
  let index = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > index) spans.push({ kind: "text", text: line.slice(index, at) });
    if (match[1]) {
      spans.push({ kind: "bold", text: match[1].slice(2, -2) });
    } else {
      spans.push({ kind: "link", text: match[2], href: match[2] });
    }
    index = at + match[0].length;
  }
  if (index < line.length) spans.push({ kind: "text", text: line.slice(index) });
  return spans;
}

// ---- Where a person stands ----

/**
 * Whether someone has agreed to the code, and to which version.
 *
 * `outdated` is a real state, not a rounding of "signed": the club changed the
 * rules, asked everybody to agree again, and this person has not. It is still
 * not a blocker (nothing about the code of conduct blocks training), so screens
 * show it as a prompt rather than a warning.
 */
export type CodeOfConductState = "unsigned" | "signed" | "outdated";

/** What the state is measured against: these facts of each stored version. */
export type CodeOfConductVersionFlags = {
  version: number;
  asks_reagreement: boolean;
  /**
   * The version anybody must have agreed to while this one is live: itself
   * when it asked, otherwise what the live version required when it was saved.
   * Fixed when the version is written (see `requiredVersionForSave`).
   */
  required_version: number;
  is_current: boolean;
};

/**
 * What the club currently asks of everybody.
 *
 * `current_version` is the live one: what the public page shows and what a
 * signature today agrees to. `required_version` is what the live version
 * requires. Anyone whose highest agreement is at least that is up to date: a
 * typo fix (saved without asking) moves the live version and leaves everybody
 * exactly where they were.
 *
 * Read off the live row rather than worked out from the history, so a rollback
 * undoes an ask for good. Rolling back from a rewritten version 5 that asked, to
 * version 4, and then saving a typo fix as version 6, must not leave the club
 * asking people to agree to the rules it rolled away from; "the newest version
 * that asked" would, as soon as 6 passed 5.
 */
export type CodeOfConductStandard = {
  current_version: number | null;
  required_version: number | null;
};

export function codeOfConductStandard(
  versions: readonly CodeOfConductVersionFlags[],
): CodeOfConductStandard {
  const live = versions.find((v) => v.is_current);
  return live
    ? { current_version: live.version, required_version: live.required_version }
    : { current_version: null, required_version: null };
}

/**
 * What a version about to be saved as `version` will require.
 *
 * Itself when it asks everybody to agree again. Otherwise it changes nothing
 * about who is up to date, so it inherits what is required now: the live
 * version's requirement, or, when nothing is live (a promotion that failed and
 * left the club without one), the newest stored version's. Only with nothing
 * stored at all is there nothing to inherit, and then it is the baseline.
 * Inheriting from "nothing live" as if it were "nothing ever asked" would put
 * every member out of date on a save that was meant to ask nobody anything.
 */
export function requiredVersionForSave(
  version: number,
  asksReagreement: boolean,
  versions: readonly CodeOfConductVersionFlags[],
): number {
  if (asksReagreement) return version;
  const live = versions.find((v) => v.is_current);
  if (live) return live.required_version;
  const newest = versions.reduce<CodeOfConductVersionFlags | null>(
    (best, v) => (!best || v.version > best.version ? v : best),
    null,
  );
  return newest ? newest.required_version : version;
}

/**
 * The state for one person, from the highest version they have agreed to.
 *
 * With nothing ever asked (`requiredVersion` null) any agreement counts. A
 * version ahead of the required one is signed: it happens after a rollback, and
 * telling somebody who agreed to newer text that they are behind is nonsense.
 */
export function codeOfConductState(
  acceptedVersion: number | null | undefined,
  requiredVersion: number | null,
): CodeOfConductState {
  if (acceptedVersion == null) return "unsigned";
  if (requiredVersion === null) return "signed";
  return acceptedVersion >= requiredVersion ? "signed" : "outdated";
}

/**
 * Whether a signature may be filed against the version a person was shown.
 *
 * Only the live one. The page sends the number of the text it rendered, so a
 * manager publishing while somebody reads makes their form stale, and filing
 * it anyway would record agreement to words that are no longer the club's, or
 * (were it filed against the new live number instead) to words they never saw.
 */
export function isSignableVersion(shown: number, standard: CodeOfConductStandard): boolean {
  return standard.current_version !== null && shown === standard.current_version;
}

/** The latest version any of these acceptances covers, or null for none. */
export function latestAcceptedVersion(
  acceptances: { version: number }[] | null | undefined,
): number | null {
  if (!acceptances || acceptances.length === 0) return null;
  return acceptances.reduce((best, a) => Math.max(best, a.version), 0) || null;
}

/**
 * Where one person stands: the state, and the acceptance that decides it.
 *
 * The acceptance is the one with the highest VERSION, not the most recent row:
 * re-signing an older version after a newer one is not a downgrade (rule 6 in
 * `docs/code-of-conduct.md`). On a tie the first row given wins, so pass them
 * newest first to report the latest signing of that version.
 *
 * One function because three surfaces report this, the member's own screens,
 * the manager person page and the manager agent API, and they must not
 * disagree about it.
 */
export function codeOfConductSummary(
  acceptances:
    { version: number; accepted_at: string; signature_name: string }[] | null | undefined,
  standard: CodeOfConductStandard,
) {
  const top = (acceptances ?? []).reduce<{
    version: number;
    accepted_at: string;
    signature_name: string;
  } | null>((best, a) => (!best || a.version > best.version ? a : best), null);
  return {
    state: codeOfConductState(top?.version ?? null, standard.required_version),
    current_version: standard.current_version,
    required_version: standard.required_version,
    accepted_version: top?.version ?? null,
    accepted_at: top?.accepted_at ?? null,
    signature_name: top?.signature_name ?? null,
  };
}

/**
 * How many people a change to what is live would move from up to date to out
 * of date: the number a manager is told before publishing.
 *
 * `highestAccepted` is each person's highest agreed version, one entry per
 * person. Only people who are `signed` before and `outdated` after count:
 * somebody already out of date was already being asked, and somebody who never
 * agreed is asked either way.
 */
export function countReprompted(
  highestAccepted: readonly number[],
  before: CodeOfConductStandard,
  after: CodeOfConductStandard,
): number {
  return highestAccepted.filter(
    (v) =>
      codeOfConductState(v, before.required_version) === "signed" &&
      codeOfConductState(v, after.required_version) === "outdated",
  ).length;
}

/**
 * The standard if a new version were saved now and made live: the next number,
 * requiring what `requiredVersionForSave` says it will.
 */
export function standardAfterSaving(
  versions: readonly CodeOfConductVersionFlags[],
  asksReagreement: boolean,
): CodeOfConductStandard {
  const next = versions.reduce((n, v) => Math.max(n, v.version), 0) + 1;
  return {
    current_version: next,
    required_version: requiredVersionForSave(next, asksReagreement, versions),
  };
}

/** The standard if an existing version were made live instead: what it requires. */
export function standardAfterPublishing(
  versions: readonly CodeOfConductVersionFlags[],
  version: number,
): CodeOfConductStandard {
  return codeOfConductStandard(versions.map((v) => ({ ...v, is_current: v.version === version })));
}

/**
 * The link that takes a person straight to the signing form.
 *
 * Omit `siteUrl` for a root-relative link (what the site itself uses); pass it
 * for an email, which needs an absolute URL. Without a token the link is just
 * the page: readable by anyone, signable only by someone the site can identify.
 */
export function buildCodeOfConductUrl(opts: { siteUrl?: string; token?: string | null }): string {
  const base = `${(opts.siteUrl ?? "").replace(/\/+$/, "")}/code-of-conduct`;
  if (!opts.token) return base;
  return `${base}?t=${encodeURIComponent(opts.token)}`;
}
