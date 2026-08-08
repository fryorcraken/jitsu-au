import { describe, expect, it } from "vitest";

import {
  checkPassword,
  describePasswordError,
  hasVariety,
  isTooLong,
  meetsLength,
  passwordByteLength,
  passwordProblem,
  personalTokens,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  type BreachStatus,
} from "./password-policy";

/** A password that passes everything, so each test can vary one thing about it. */
const GOOD = "otter kettle marina drill";

describe("password policy constants", () => {
  it("requires 15 characters, the NIST single-factor minimum", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(15);
  });

  it("caps at bcrypt's 72 bytes", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });
});

describe("meetsLength", () => {
  it("rejects anything under the minimum", () => {
    expect(meetsLength("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
    expect(meetsLength("a".repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });

  it("counts code points, so an emoji counts once and not twice", () => {
    // 13 letters plus one emoji is 14 characters, but JavaScript's `.length`
    // counts the emoji twice and would wrongly wave it through at 15.
    expect("abcdefghijklm🥋".length).toBe(15);
    expect(meetsLength("abcdefghijklm🥋")).toBe(false);
    expect(meetsLength("abcdefghijklmn🥋")).toBe(true);
  });

  it("counts a space as a character, because a passphrase is mostly spaces", () => {
    expect(meetsLength("a b c d e f g h")).toBe(true);
  });
});

describe("isTooLong", () => {
  it("measures bytes rather than characters, the way bcrypt truncates", () => {
    expect(passwordByteLength("é")).toBe(2);
    // 72 accented characters look like 72 to a person but are 144 bytes, all
    // but the first 72 of which bcrypt would silently discard.
    expect(isTooLong("é".repeat(72))).toBe(true);
    expect(isTooLong("é".repeat(36))).toBe(false);
    expect(isTooLong("a".repeat(72))).toBe(false);
    expect(isTooLong("a".repeat(73))).toBe(true);
  });
});

describe("hasVariety", () => {
  it("rejects one character held down", () => {
    expect(hasVariety("aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("rejects a short unit typed over and over", () => {
    expect(hasVariety("abcabcabcabcabcabc")).toBe(false);
    expect(hasVariety("abcdeabcdeabcdeabcde")).toBe(false);
    expect(hasVariety("ab ab ab ab ab ab ")).toBe(false);
  });

  it("rejects a unit too long for the old seven character cap", () => {
    // At a fifteen character minimum, one eight letter word typed twice is the
    // obvious way to reach the length, and it used to pass.
    expect(hasVariety("passwordpassword")).toBe(false);
    expect(hasVariety("abcdefghabcdefgh")).toBe(false);
    expect(hasVariety("correcthorsecorrecthorse")).toBe(false);
  });

  it("does not choke on a pasted novel", () => {
    // There is no backtracking left to reason about: this was a backreference
    // regex, and the field runs it on every keystroke.
    const started = performance.now();
    expect(hasVariety("otter kettle marina drill ".repeat(20_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("accepts an ordinary passphrase", () => {
    expect(hasVariety(GOOD)).toBe(true);
  });

  it("does not ask for any particular kind of character", () => {
    // All lower case, no digits, no symbols. NIST 800-63B-4 forbids requiring
    // those, so this has to pass.
    expect(hasVariety("thequickbrownfoxjumps")).toBe(true);
  });
});

describe("personalTokens", () => {
  it("always includes the club's own names", () => {
    expect(personalTokens()).toContain("jitsu");
    expect(personalTokens()).toContain("utsjitsu");
  });

  it("takes an email's local part and drops the domain", () => {
    const tokens = personalTokens(["sam.rivers@example.com"]);
    expect(tokens).toContain("samrivers");
    expect(tokens).toContain("rivers");
    expect(tokens).not.toContain("example");
  });

  it("splits a hyphenated name into its parts as well as the whole", () => {
    const tokens = personalTokens(["Mary-Jane"]);
    expect(tokens).toEqual(expect.arrayContaining(["maryjane", "mary", "jane"]));
  });

  it("drops tokens under four characters, which match innocent words", () => {
    // "uts" is inside "outstanding"; a rule that fires on it is a rule people
    // learn to ignore.
    expect(personalTokens(["UTS", "Bo"])).not.toContain("uts");
    expect(personalTokens(["UTS"])).toEqual(personalTokens([]));
  });

  it("ignores blanks and nulls from an unloaded profile", () => {
    expect(personalTokens([null, undefined, ""])).toEqual(personalTokens([]));
  });
});

describe("passwordProblem", () => {
  it("passes a long passphrase with nothing but lower case letters and spaces", () => {
    expect(passwordProblem(GOOD)).toBeNull();
  });

  it("rejects the short-with-symbols password the old rule allowed", () => {
    // The previous rule was minLength 8, so this used to be acceptable. It is
    // the exact shape composition rules produce, and it is 10 characters.
    expect(passwordProblem("Password1!")).toMatch(/at least|more character/i);
  });

  it("says how many more characters are needed", () => {
    expect(passwordProblem("abcdefghijkl")).toContain("3 more characters");
    expect(passwordProblem("abcdefghijklmn")).toContain("1 more character");
  });

  it("rejects a long password made of one repeated thing", () => {
    expect(passwordProblem("abcabcabcabcabcabc")).toMatch(/repeated/i);
  });

  it("rejects a password built from the person's own email", () => {
    expect(
      passwordProblem("samrivers is my name", { personal: ["samrivers@example.com"] }),
    ).toMatch(/knows you could guess/i);
  });

  it("rejects a password built from the club's name", () => {
    expect(passwordProblem("utsjitsu training club")).toMatch(/knows you could guess/i);
  });

  it("sees through punctuation and capitals used to dodge that", () => {
    expect(passwordProblem("J.i.T.s.U-J.i.T.s.U-club")).toMatch(/knows you could guess/i);
  });

  it("leaves a passphrase alone when the name is only a small part of it", () => {
    // "Hill" is a surname and also an ordinary word. Rejecting four unrelated
    // words because one of them happens to be somebody's name is how a rule
    // set loses the person reading it.
    expect(passwordProblem("hill kettle marina drill", { personal: ["Hill"] })).toBeNull();
  });

  it("does not match across a join that flattening the punctuation invented", () => {
    // "flash escape" only contains "ashe" once the space is stripped out.
    expect(passwordProblem("flash escape marina drill", { personal: ["Ashe"] })).toBeNull();
  });

  it("still rejects a password that is mostly the person's surname", () => {
    expect(passwordProblem("hillsboro hill road", { personal: ["Hill"] })).toMatch(
      /knows you could guess/i,
    );
  });

  it("rejects a password that is the person's first and last name", () => {
    // Measured one word at a time, neither half reaches a third (each is 9 of
    // 29 letters), so this used to sail through the rule that exists to stop
    // exactly it.
    const personal = ["alex.dominguez@example.com", "Alexander", "Dominguez"];
    expect(passwordProblem("alexander dominguez kettle drill", { personal })).toMatch(
      /knows you could guess/i,
    );
  });

  it("does not count overlapping words twice when adding them up", () => {
    // The tokens overlap by construction: the email local part contains the
    // first name, and "utsjitsu" contains "jitsu". Counting the same letters
    // three times would start refusing honest passphrases.
    const personal = ["rose.hill@example.com", "Rose", "Hill"];
    expect(passwordProblem("rose kettle marina drill anvil", { personal })).toBeNull();
  });

  it("folds accents rather than deleting them", () => {
    // "Müller" reduced to "mller" before this, which matches nothing anybody
    // types, so the rule quietly did nothing for members with accented names.
    expect(passwordProblem("müller müller kettle", { personal: ["Müller"] })).toMatch(
      /knows you could guess/i,
    );
    expect(passwordProblem("muller muller kettle", { personal: ["Müller"] })).toMatch(
      /knows you could guess/i,
    );
  });

  it("rejects a password past bcrypt's ceiling", () => {
    expect(passwordProblem("a b c d e f g h i j ".repeat(4))).toMatch(/72 characters/);
  });

  it("explains the ceiling differently when characters and bytes disagree", () => {
    // 40 accented characters is 80 bytes. Telling somebody holding 40 of
    // something that the limit is 72 reads as a broken form.
    const message = passwordProblem("é".repeat(40)) ?? "";
    expect(message).toMatch(/72 characters of plain text/);
    expect(message).toMatch(/use up more than one/);
  });

  it("reports the length problem before the personal one, so there is one thing to fix", () => {
    expect(passwordProblem("jitsu", { personal: [] })).toMatch(/more character/i);
  });

  it("blocks a password the breach lookup has come back on", () => {
    // A red cross on screen has to mean the button will not work.
    expect(passwordProblem(GOOD, { breach: "breached" })).toMatch(/data breach/i);
  });

  it("lets the form through while the lookup is unfinished or unreachable", () => {
    expect(passwordProblem(GOOD, { breach: "checking" })).toBeNull();
    expect(passwordProblem(GOOD, { breach: "unknown" })).toBeNull();
    expect(passwordProblem(GOOD, { breach: "idle" })).toBeNull();
    expect(passwordProblem(GOOD)).toBeNull();
  });
});

describe("checkPassword", () => {
  it("lists every rule, in a fixed order", () => {
    expect(checkPassword("").map((rule) => rule.id)).toEqual([
      "length",
      "variety",
      "notPersonal",
      "notBreached",
    ]);
  });

  it("keeps the ceiling out of the list until it is broken", () => {
    // It is a limit nobody approaches, so it would sit green forever.
    expect(checkPassword(GOOD).map((rule) => rule.id)).not.toContain("maxLength");
  });

  it("shows the ceiling as a failed rule once it is broken", () => {
    // Otherwise the list reads 4 of 4 while the form refuses to submit, which
    // is the exact mismatch this whole change is about.
    const rules = checkPassword("a".repeat(80));
    const ceiling = rules.find((rule) => rule.id === "maxLength");
    expect(ceiling?.state).toBe("unmet");
    expect(ceiling?.label).toContain("72");
  });

  it("does not put a character count on the ceiling when bytes are what ran out", () => {
    const ceiling = checkPassword("é".repeat(40)).find((rule) => rule.id === "maxLength");
    expect(ceiling?.label).not.toContain("72");
    expect(ceiling?.label).toMatch(/store/i);
  });

  function breachState(breach: BreachStatus) {
    return checkPassword(GOOD, { breach }).find((rule) => rule.id === "notBreached")?.state;
  }

  it("holds the breach rule open until a lookup has answered", () => {
    expect(breachState("idle")).toBe("pending");
    expect(breachState("checking")).toBe("pending");
  });

  it("marks the breach rule met when the password is clear", () => {
    expect(breachState("safe")).toBe("met");
  });

  it("marks the breach rule unmet when the password has leaked", () => {
    expect(breachState("breached")).toBe("unmet");
  });

  it("does not hold an unreachable lookup against the person", () => {
    // Supabase checks this again server side, so a third party being down must
    // not read as a failed rule.
    expect(breachState("unknown")).toBe("met");
  });

  it("states the minimum in the rule's own label", () => {
    expect(checkPassword("").find((rule) => rule.id === "length")?.label).toContain("15");
  });
});

describe("describePasswordError", () => {
  it("turns Supabase's bare weak-password refusal into something actionable", () => {
    const supabaseMessage =
      "Password is known to be weak and easy to guess, please choose a different one.";
    const rewritten = describePasswordError(supabaseMessage);
    expect(rewritten).not.toBe(supabaseMessage);
    expect(rewritten).toMatch(/data breach/i);
    expect(rewritten).toMatch(/unrelated words/i);
  });

  it("restates the length rule with our minimum, not Supabase's", () => {
    expect(describePasswordError("Password should be at least 8 characters.")).toContain("15");
  });

  it("explains the 72 character ceiling", () => {
    expect(describePasswordError("Password cannot be longer than 72 characters")).toMatch(
      /72 characters/,
    );
  });

  it("answers a character-class complaint with length instead", () => {
    const message =
      "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789.";
    expect(describePasswordError(message)).toMatch(/length is what counts/i);
  });

  it("passes an unrecognised message through rather than swallowing it", () => {
    expect(describePasswordError("Auth session missing!")).toBe("Auth session missing!");
  });

  it("contains no em dash, which the copy rules forbid", () => {
    const messages = [
      describePasswordError("Password is known to be weak and easy to guess."),
      describePasswordError("Password should be at least 8 characters."),
      describePasswordError("Password cannot be longer than 72 characters"),
      passwordProblem("short"),
      passwordProblem("aaaaaaaaaaaaaaaaaa"),
      passwordProblem("utsjitsu training club"),
      passwordProblem("a".repeat(80)),
      passwordProblem("é".repeat(40)),
      passwordProblem("otter kettle marina drill", { breach: "breached" }),
      ...checkPassword("").map((rule) => rule.label),
      ...checkPassword("é".repeat(40)).map((rule) => rule.label),
    ];
    // Every entry has to be a real message: a null here would silently pass.
    expect(messages.every((message) => typeof message === "string" && message.length > 0)).toBe(
      true,
    );
    for (const message of messages) expect(message).not.toContain("—");
  });
});
