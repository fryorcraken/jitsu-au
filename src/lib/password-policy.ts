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

export type PasswordRuleId = "length" | "variety" | "notPersonal" | "notBreached" | "maxLength";

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

/**
 * Strip a string down to what a guesser would actually try: letters and digits.
 *
 * Accents are folded rather than deleted (NFD splits "ü" into "u" plus a
 * combining mark, and only the mark is dropped). Without that step "Müller"
 * would reduce to "mller", which matches nothing a person would type, and the
 * rule would quietly stop working for exactly the members whose names carry
 * diacritics. Both sides of every comparison go through here, so they agree.
 */
function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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

/**
 * How much of a password one of those words has to account for before it is
 * the reason the password is guessable.
 *
 * Plain substring matching is too blunt to use on its own. "Hill", "Rose",
 * "Dean" and "Bell" are surnames and also ordinary words, and flattening the
 * punctuation out before matching creates joins nobody typed ("flash escape"
 * contains "ashe"). Rejecting a strong passphrase with "leave out your name"
 * is how a rule set loses the person reading it.
 *
 * A third is the line. At fifteen characters minimum, a four or five letter
 * surname cannot reach it by accident, while the passwords this rule is
 * actually for, the ones that ARE somebody's name with a bit of decoration,
 * are well past it.
 */
const PERSONAL_SHARE = 1 / 3;

/**
 * The share of the password covered by these words TAKEN TOGETHER.
 *
 * Together, not the largest of them separately. Measuring one word at a time
 * lets a full name through: in "alexander dominguez kettle drill" neither half
 * reaches a third on its own (each is 9 of 29 letters), so a password that is
 * nothing but the member's own first and last name passed a rule whose label
 * promises otherwise.
 *
 * Marking positions rather than adding lengths is what makes "together" safe.
 * The words overlap by construction (an email local part contains the first
 * name; "utsjitsu" contains "jitsu"), and adding them up would count the same
 * letters two and three times and start refusing honest passphrases.
 */
function personalShare(password: string, tokens: string[]): number {
  const flattened = normalise(password);
  if (!flattened) return 0;
  const covered = new Array<boolean>(flattened.length).fill(false);
  for (const token of tokens) {
    for (let at = flattened.indexOf(token); at !== -1; at = flattened.indexOf(token, at + 1)) {
      for (let i = at; i < at + token.length; i++) covered[i] = true;
    }
  }
  return covered.filter(Boolean).length / flattened.length;
}

function isBuiltFromPersonal(password: string, tokens: string[]): boolean {
  return personalShare(password, tokens) >= PERSONAL_SHARE;
}

/**
 * Whether the password is some unit typed over and over: "abcabcabcabcabc",
 * "passwordpassword".
 *
 * Every unit length is tried, not the first few. This was a regex with the
 * repeat capped at seven characters, and "passwordpassword" walked through it
 * on a unit of eight, which is not an edge case: at a fifteen character
 * minimum, an eight letter word typed twice is the obvious way to reach the
 * length. A loop rather than a backreference also means no backtracking to
 * reason about on a pasted megabyte, and it compares code points, so an emoji
 * counts once here the same as it does everywhere else in this file.
 */
function isRepeatedUnit(password: string): boolean {
  const chars = [...password];
  const length = chars.length;
  for (let unit = 1; unit <= length / 2; unit++) {
    if (length % unit !== 0) continue;
    let repeats = true;
    for (let i = unit; i < length && repeats; i++) {
      if (chars[i] !== chars[i - unit]) repeats = false;
    }
    if (repeats) return true;
  }
  return false;
}

/**
 * Reject the degenerate ways to reach the length without adding any guesswork:
 * one character held down, or a unit typed over and over.
 *
 * This is not a composition rule. It asks for no particular kind of character,
 * only that there be more than a handful of distinct ones, so "aaaaaaaaaaaaaaa"
 * and "abcabcabcabcabc" do not pass as fifteen characters of anything.
 */
export function hasVariety(password: string): boolean {
  if (new Set([...password]).size < 5) return false;
  return !isRepeatedUnit(password);
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
 * The ceiling stated to someone who has hit it.
 *
 * "72 characters" is only true of plain text. Told that while holding a
 * thirty-character Japanese passphrase, a person would reasonably conclude the
 * form is broken, so when the two counts disagree the reason comes with the
 * number.
 */
function ceilingWording(password: string): { label: string; message: string } {
  if (passwordByteLength(password) === [...password].length) {
    return {
      label: `No longer than ${PASSWORD_MAX_BYTES} characters`,
      message: `That is longer than we can store. Passwords go up to ${PASSWORD_MAX_BYTES} characters.`,
    };
  }
  return {
    label: "Short enough for us to store",
    message: `That is longer than we can store. The limit is ${PASSWORD_MAX_BYTES} characters of plain text, and accented, emoji and non-Latin characters each use up more than one.`,
  };
}

/** The copy for a password found in breach data, shared by the live check and Supabase's refusal. */
const BREACHED_MESSAGE =
  "That password has turned up in a public data breach, which puts it on the lists attackers try first. It has to be a different one. Three or four unrelated words is the easiest way to get there.";

/**
 * Every rule and where this password stands against it, in the order the field
 * lists them. The breach rule is `pending` until a lookup has answered, and
 * counts as met when the lookup could not run at all: the server checks it
 * again anyway, and a third party being unreachable is not the person's fault.
 *
 * The ceiling is the odd one out: it appears only once it has been broken. It
 * is a limit nobody approaches, and a rule sitting green from the first
 * keystroke to the last is noise in a list that is meant to be read. It has to
 * appear then, though, because it does stop the form, and a list showing all
 * green next to a refusal is the thing this whole change is fixing.
 */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordRule[] {
  const breach = context.breach ?? "idle";
  const tokens = personalTokens(context.personal);
  const breachState: PasswordRuleState =
    breach === "breached" ? "unmet" : breach === "safe" || breach === "unknown" ? "met" : "pending";

  const rules: PasswordRule[] = [
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
      label: "Not built out of your name, your email, or the club's name",
      state: isBuiltFromPersonal(password, tokens) ? "unmet" : "met",
    },
    {
      id: "notBreached",
      label: "Not one of the passwords found in public data breaches",
      state: breachState,
    },
  ];

  if (isTooLong(password)) {
    rules.push({ id: "maxLength", label: ceilingWording(password).label, state: "unmet" });
  }
  return rules;
}

/**
 * The one thing wrong with this password, phrased as what to do about it, or
 * null when there is nothing to fix. Forms call this to decide whether to
 * submit.
 *
 * The breach lookup only blocks when it has actually come back saying the
 * password has leaked. "Checking" and "unknown" both let the form through: it
 * is a call to a third party that can be slow or down, and nobody should be
 * unable to set a password because someone else's API is having an afternoon.
 * Supabase checks the same thing server side regardless, and
 * `describePasswordError` turns its refusal into something worth reading.
 */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
  if (isTooLong(password)) return ceilingWording(password).message;
  if (!meetsLength(password)) {
    const short = PASSWORD_MIN_LENGTH - [...password].length;
    return `A bit short. Add ${short} more character${short === 1 ? "" : "s"} to reach ${PASSWORD_MIN_LENGTH}.`;
  }
  if (!hasVariety(password)) {
    return "That is the same thing repeated, so it is as short as its shortest part. Try a few unrelated words instead.";
  }
  if (isBuiltFromPersonal(password, personalTokens(context.personal))) {
    return "Anyone who knows you could guess that. Leave out your name, your email and the club's name.";
  }
  // Last, and only on a definite answer: a red cross on screen has to mean the
  // button will not work, or the list is decoration.
  if (context.breach === "breached") return BREACHED_MESSAGE;
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
  if (text.includes("known to be weak")) return BREACHED_MESSAGE;
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
