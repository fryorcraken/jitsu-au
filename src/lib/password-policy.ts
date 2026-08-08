// The club's password rules, written down once, in a form a person can read.
//
// The rules follow NIST SP 800-63B-4 (Digital Identity Guidelines, August 2025)
// and the OWASP Authentication Cheat Sheet, not the older "one capital, one
// number, one symbol" habit. That habit is worse than nothing: it is what
// produces `Password1!` and its cousins, which is precisely the shape of every
// credential-stuffing list. Both documents now say the same two things instead,
// and they are what this module enforces:
//
//   * LENGTH is the control that matters. NIST requires 15 characters when the
//     password is the only factor, which is our case (this site has no second
//     factor; the alternative here is the emailed sign-in link, not an app
//     code). Eight is only permitted when a second factor backs it up.
//   * NOT HAVING LEAKED is the other one. Almost every real account takeover
//     starts with a password already published in a breach, so a password gets
//     checked against that corpus rather than against a character-class rule.
//
// And the thing we deliberately do NOT do: NIST 800-63B-4 says verifiers SHALL
// NOT impose composition rules. Every character is allowed here, spaces and
// emoji included, and nothing is required to appear.
//
// Two of the numbers are not ours to pick:
//
//   * 72 is a hard ceiling from bcrypt, which is what Supabase hashes with.
//     bcrypt ignores everything past byte 72, so a longer passphrase would be
//     silently truncated to something shorter than the person thinks they set.
//     Supabase rejects it outright, and so do we, with an explanation.
//   * The breach check itself already runs server side: Supabase's leaked
//     password protection queries Have I Been Pwned, and its rejection is the
//     bare "Password is known to be weak and easy to guess, please choose a
//     different one." that sent nobody anywhere useful. That check stays (it is
//     the authority), but the same lookup now runs as you type, so the answer
//     arrives before you commit to a password rather than after.
//
// Pure and side-effect free, like `validation.ts` next to it: the network half
// of the breach check lives in `pwned-passwords.ts` so these rules stay
// unit-testable on their own.

/**
 * Minimum length. NIST SP 800-63B-4 section 3.1.1.2: 15 characters for a
 * password used as a single factor.
 *
 * Raising this does not lock anybody out. It is checked when a password is
 * SET, never when one is used to sign in, so members holding an older, shorter
 * password keep signing in with it until they change it.
 */
export const PASSWORD_MIN_LENGTH = 15;

/**
 * Maximum length, in BYTES rather than characters, because that is how bcrypt
 * counts: a passphrase of accented or non-Latin characters runs out sooner
 * than a plain ASCII one of the same visible length.
 */
export const PASSWORD_MAX_BYTES = 72;

/** Names the club answers to. A password should not be guessable from the sign. */
const CLUB_TERMS = ["jitsu", "jiujitsu", "utsjitsu", "jitsuau"];

/** How the breach lookup is going. `unknown` means we could not find out. */
export type BreachStatus = "idle" | "checking" | "safe" | "breached" | "unknown";

export type PasswordRuleId = "length" | "variety" | "notPersonal" | "notBreached";

/** `pending` is "we cannot say yet", which is only ever the breach lookup. */
export type PasswordRuleState = "met" | "unmet" | "pending";

export type PasswordRule = {
  id: PasswordRuleId;
  /** Shown to the person, so it is the rule itself and not a description of it. */
  label: string;
  state: PasswordRuleState;
};

export type PasswordContext = {
  /**
   * Things this person is publicly associated with: their email address, the
   * parts of their name. A password built out of these is guessable by anyone
   * who has met them.
   */
  personal?: (string | null | undefined)[];
  /** Result of the Have I Been Pwned lookup, if one has run. */
  breach?: BreachStatus;
};

/** Strip a string down to what a guesser would actually try: letters and digits. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/**
 * The words a password must not be built from, drawn from whatever the caller
 * knows about the person plus the club's own names.
 *
 * Tokens shorter than four characters are dropped rather than matched. "uts"
 * is a substring of "outstanding", and a rule that rejects an honest
 * passphrase for containing three incidental letters teaches people to stop
 * reading the rules.
 */
export function personalTokens(personal: (string | null | undefined)[] = []): string[] {
  const tokens = new Set<string>(CLUB_TERMS);
  for (const raw of personal) {
    if (!raw) continue;
    // An email is only guessable up to the "@": the domain is shared by
    // thousands of people and rejecting "gmail" would be noise.
    const value = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
    // Split as well as taking the whole, so "mary-jane" contributes all three
    // of "maryjane", "mary" and "jane".
    for (const piece of [value, ...value.split(/[^A-Za-z0-9]+/)]) {
      const token = normalise(piece);
      if (token.length >= 4) tokens.add(token);
    }
  }
  return [...tokens];
}

function containsPersonal(password: string, tokens: string[]): boolean {
  const flattened = normalise(password);
  if (!flattened) return false;
  return tokens.some((token) => flattened.includes(token));
}

/**
 * Reject the degenerate ways to reach the length without adding any guesswork:
 * one character held down, or a short unit typed over and over.
 *
 * This is not a composition rule. It asks for no particular kind of character,
 * only that there be more than a handful of distinct ones, so "aaaaaaaaaaaaaaa"
 * and "abcabcabcabcabc" do not pass as fifteen characters of anything.
 */
export function hasVariety(password: string): boolean {
  if (new Set([...password]).size < 5) return false;
  return !/^(.{1,7}?)\1+$/s.test(password);
}

export function meetsLength(password: string): boolean {
  // Count code points, not UTF-16 units, so an emoji counts once rather than
  // twice and nobody reaches 15 with seven of them.
  return [...password].length >= PASSWORD_MIN_LENGTH;
}

export function isTooLong(password: string): boolean {
  return passwordByteLength(password) > PASSWORD_MAX_BYTES;
}

/**
 * Every rule and where this password stands against it, in the order the field
 * lists them. The breach rule is `pending` until a lookup has answered, and
 * counts as met when the lookup could not run at all: the server checks it
 * again anyway, and a third party being unreachable is not the person's fault.
 */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordRule[] {
  const breach = context.breach ?? "idle";
  const tokens = personalTokens(context.personal);
  const breachState: PasswordRuleState =
    breach === "breached" ? "unmet" : breach === "safe" || breach === "unknown" ? "met" : "pending";

  return [
    {
      id: "length",
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      state: meetsLength(password) ? "met" : "unmet",
    },
    {
      id: "variety",
      label: "Not one character or short pattern repeated",
      state: hasVariety(password) ? "met" : "unmet",
    },
    {
      id: "notPersonal",
      label: "Nothing from your name, your email, or the club's name",
      state: containsPersonal(password, tokens) ? "unmet" : "met",
    },
    {
      id: "notBreached",
      label: "Not one of the passwords found in public data breaches",
      state: breachState,
    },
  ];
}

/**
 * The one thing wrong with this password, phrased as what to do about it, or
 * null when there is nothing to fix. Forms call this to decide whether to
 * submit.
 *
 * The breach lookup is deliberately not consulted here. It is a call to a
 * third party that can be slow or down, and a member should never be unable to
 * set a password because someone else's API is having an afternoon. Supabase
 * enforces that half server side regardless, and `describePasswordError` turns
 * its refusal into something worth reading.
 */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
  if (isTooLong(password)) {
    return `That is longer than we can store. Passwords go up to ${PASSWORD_MAX_BYTES} characters.`;
  }
  if (!meetsLength(password)) {
    const short = PASSWORD_MIN_LENGTH - [...password].length;
    return `A bit short. Add ${short} more character${short === 1 ? "" : "s"} to reach ${PASSWORD_MIN_LENGTH}.`;
  }
  if (!hasVariety(password)) {
    return "That is the same thing repeated, so it is as short as its shortest part. Try a few unrelated words instead.";
  }
  if (containsPersonal(password, personalTokens(context.personal))) {
    return "Anyone who knows you could guess that. Leave out your name, your email and the club's name.";
  }
  return null;
}

/**
 * Supabase's own password refusals, rewritten for the person reading them.
 *
 * The strings are matched loosely on purpose: they come from GoTrue, we do not
 * own them, and an unrecognised one falls through unchanged rather than being
 * swallowed. `weak_password` is the interesting case, and its bare wording
 * ("known to be weak and easy to guess") is what this whole module is a
 * reaction to: it tells you that you failed without telling you the rule.
 */
export function describePasswordError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("known to be weak")) {
    return "That password has turned up in a public data breach, which puts it on the lists attackers try first. It has to be a different one. Three or four unrelated words is the easiest way to get there.";
  }
  if (text.includes("should be at least")) {
    return `A bit short. Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (text.includes("longer than 72")) {
    return `That is longer than we can store. Passwords go up to ${PASSWORD_MAX_BYTES} characters.`;
  }
  if (text.includes("at least one character of each")) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. Length is what counts, so a few unrelated words beats a short one with symbols in it.`;
  }
  if (text.includes("different from the old password")) {
    return "That is the password you already have. Pick a new one.";
  }
  return message;
}
