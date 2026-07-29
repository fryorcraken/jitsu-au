import { describe, it, expect } from "vitest";
import {
  DEFAULT_VERIFY_REDIRECT,
  VERIFICATION_TOKEN_TTL_DAYS,
  buildVerifyUrl,
  emailVerificationLabel,
  isEmailVerified,
  isVerificationTokenLive,
  tokenProvesEmail,
  verificationExpiry,
  verifyRedirectPath,
} from "./email-verification";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe("isVerificationTokenLive", () => {
  it("honours a token inside its window", () => {
    expect(isVerificationTokenLive({ expires_at: days(1) }, NOW)).toBe(true);
  });

  it("rejects an expired token", () => {
    expect(isVerificationTokenLive({ expires_at: days(-1) }, NOW)).toBe(false);
  });

  it("treats the exact expiry instant as expired", () => {
    expect(isVerificationTokenLive({ expires_at: NOW.toISOString() }, NOW)).toBe(false);
  });

  it("rejects a revoked token even while unexpired", () => {
    // A manager corrected the address: every link to the old one goes inert
    // immediately, without waiting out the six-month expiry.
    expect(isVerificationTokenLive({ expires_at: days(90), revoked_at: days(-1) }, NOW)).toBe(
      false,
    );
  });

  it("fails closed on an unparseable expiry", () => {
    expect(isVerificationTokenLive({ expires_at: "not a date" }, NOW)).toBe(false);
  });
});

describe("verificationExpiry", () => {
  it("is the configured TTL out from now", () => {
    expect(verificationExpiry(NOW)).toBe(days(VERIFICATION_TOKEN_TTL_DAYS));
  });

  it("mints a token that is live well after a member forgets about it", () => {
    // The interest email's token doubles as the waiver prefill link, so it has
    // to survive someone taking a month to get around to signing.
    const token = { expires_at: verificationExpiry(NOW) };
    expect(isVerificationTokenLive(token, new Date(days(30)))).toBe(true);
  });
});

describe("isEmailVerified / emailVerificationLabel", () => {
  it("reads a confirmation stamp as verified", () => {
    expect(isEmailVerified("2026-07-01T00:00:00.000Z")).toBe(true);
    expect(emailVerificationLabel("2026-07-01T00:00:00.000Z")).toBe("verified");
  });

  it("treats a missing stamp as unverified", () => {
    expect(isEmailVerified(null)).toBe(false);
    expect(isEmailVerified(undefined)).toBe(false);
    expect(emailVerificationLabel(null)).toBe("unverified");
  });
});

describe("tokenProvesEmail", () => {
  it("matches regardless of case and surrounding space", () => {
    expect(tokenProvesEmail(" Ada@Example.com ", "ada@example.com")).toBe(true);
  });

  it("refuses to verify an address the token was not sent to", () => {
    // The case the whole guard exists for: a manager fixed a typo, and a link
    // mailed to the OLD address must never confirm the new one.
    expect(tokenProvesEmail("typo@example.com", "correct@example.com")).toBe(false);
  });

  it("refuses when the account has no address to compare", () => {
    expect(tokenProvesEmail("ada@example.com", null)).toBe(false);
  });

  it("refuses on an empty token address rather than matching an empty account", () => {
    expect(tokenProvesEmail("  ", "")).toBe(false);
  });
});

describe("verifyRedirectPath", () => {
  it("keeps an allowlisted path", () => {
    expect(verifyRedirectPath("/account")).toBe("/account");
    expect(verifyRedirectPath("/waiver")).toBe("/waiver");
  });

  it("falls back when nothing was asked for", () => {
    expect(verifyRedirectPath(null)).toBe(DEFAULT_VERIFY_REDIRECT);
    expect(verifyRedirectPath("")).toBe(DEFAULT_VERIFY_REDIRECT);
  });

  it("refuses to send someone off-site", () => {
    expect(verifyRedirectPath("https://evil.example/steal")).toBe(DEFAULT_VERIFY_REDIRECT);
    // Protocol-relative: a naive "starts with /" check would let this through
    // and hand the visitor to another host.
    expect(verifyRedirectPath("//evil.example")).toBe(DEFAULT_VERIFY_REDIRECT);
  });

  it("refuses an internal path that is not on the list", () => {
    expect(verifyRedirectPath("/manager/users")).toBe(DEFAULT_VERIFY_REDIRECT);
  });
});

describe("buildVerifyUrl", () => {
  it("builds the emailed link", () => {
    expect(
      buildVerifyUrl({ siteUrl: "https://jitsu.au", token: "utsj_abc", next: "/account" }),
    ).toBe("https://jitsu.au/api/verify-email/utsj_abc?next=%2Faccount");
  });

  it("tolerates a trailing slash on the site URL", () => {
    expect(buildVerifyUrl({ siteUrl: "https://jitsu.au/", token: "utsj_abc" })).toBe(
      "https://jitsu.au/api/verify-email/utsj_abc?next=%2Faccount",
    );
  });

  it("never embeds an attacker-supplied redirect", () => {
    const url = buildVerifyUrl({
      siteUrl: "https://jitsu.au",
      token: "utsj_abc",
      next: "https://evil.example",
    });
    expect(url).toContain("next=%2Faccount");
    expect(url).not.toContain("evil.example");
  });
});
