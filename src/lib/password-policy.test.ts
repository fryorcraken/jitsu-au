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
    expect(passwordProblem("J.i.T.s.U-training-hall")).toMatch(/knows you could guess/i);
  });

  it("rejects a password past bcrypt's ceiling", () => {
    expect(passwordProblem("a b c d e f g h i j ".repeat(4))).toMatch(/72 characters/);
  });

  it("reports the length problem before the personal one, so there is one thing to fix", () => {
    expect(passwordProblem("jitsu", { personal: [] })).toMatch(/more character/i);
  });

  it("never consults the breach lookup, which may be unreachable", () => {
    expect(passwordProblem(GOOD, { breach: "breached" })).toBeNull();
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
      passwordProblem("short"),
      passwordProblem("aaaaaaaaaaaaaaaaaa"),
      passwordProblem("jitsu is the best club"),
      ...checkPassword("").map((rule) => rule.label),
    ];
    for (const message of messages) expect(message).not.toContain("—");
  });
});
