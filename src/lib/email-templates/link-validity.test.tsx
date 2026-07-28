import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { EmailChangeEmail } from "./email-change";
import { InviteEmail } from "./invite";
import { AUTH_LINK_VALIDITY_MINUTES, formatAuthLinkValidity } from "./link-validity";
import { MagicLinkEmail } from "./magic-link";
import { ReauthenticationEmail } from "./reauthentication";
import { RecoveryEmail } from "./recovery";
import { SignupEmail } from "./signup";

const SITE = { siteName: "UTS Jitsu", siteUrl: "https://jitsu.au" };
const CONFIRMATION_URL = "https://jitsu.au/auth/confirm?token=abc";

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderEmail = (Template: React.ComponentType<any>, props: object) =>
  render(React.createElement(Template, props)).then(visibleText);

describe("formatAuthLinkValidity", () => {
  it("renders whole hours as hours and anything else as minutes", () => {
    expect(formatAuthLinkValidity(60)).toBe("1 hour");
    expect(formatAuthLinkValidity(120)).toBe("2 hours");
    expect(formatAuthLinkValidity(10)).toBe("10 minutes");
    expect(formatAuthLinkValidity(1)).toBe("1 minute");
  });

  it("defaults to the configured window", () => {
    expect(formatAuthLinkValidity()).toBe(formatAuthLinkValidity(AUTH_LINK_VALIDITY_MINUTES));
  });
});

describe("auth emails state how long their link or code lasts", () => {
  // The window is Supabase's "Email OTP Expiration", which no test can read.
  // Pinning it here makes a copy change a deliberate edit that has to be matched
  // in the dashboard, rather than something that quietly drifts out of true.
  it("is pinned to the live Supabase setting of 1 hour", () => {
    expect(AUTH_LINK_VALIDITY_MINUTES).toBe(60);
    expect(formatAuthLinkValidity()).toBe("1 hour");
  });

  it("says it on the login link email", async () => {
    const text = await renderEmail(MagicLinkEmail, { ...SITE, confirmationUrl: CONFIRMATION_URL });

    expect(text).toContain("The link is valid for 1 hour");
    expect(text).not.toContain("expire shortly");
  });

  it("says it on the confirmation email, which is what an approved applicant gets", async () => {
    const text = await renderEmail(SignupEmail, {
      ...SITE,
      recipient: "member@example.test",
      confirmationUrl: CONFIRMATION_URL,
    });

    expect(text).toContain("The link is valid for 1 hour");
  });

  it("says it on the invite email", async () => {
    const text = await renderEmail(InviteEmail, { ...SITE, confirmationUrl: CONFIRMATION_URL });

    expect(text).toContain("The link is valid for 1 hour");
  });

  it("says it on the password reset email", async () => {
    const text = await renderEmail(RecoveryEmail, { ...SITE, confirmationUrl: CONFIRMATION_URL });

    expect(text).toContain("The link is valid for 1 hour");
  });

  it("says it on the reauthentication code email", async () => {
    const text = await renderEmail(ReauthenticationEmail, { token: "123456" });

    expect(text).toContain("This code is valid for 1 hour");
    expect(text).not.toContain("expire shortly");
  });

  // The email-change link runs on the same setting, but its copy is untouched
  // here; this pins that gap so it stays a decision rather than an oversight.
  it("does not claim a window on the email-change email", async () => {
    const text = await renderEmail(EmailChangeEmail, {
      ...SITE,
      oldEmail: "old@example.test",
      email: "old@example.test",
      newEmail: "new@example.test",
      confirmationUrl: CONFIRMATION_URL,
    });

    expect(text).not.toContain("valid for");
  });
});

describe("MagicLinkEmail", () => {
  it("links the button at the confirmation url", async () => {
    const html = await render(
      React.createElement(MagicLinkEmail, { ...SITE, confirmationUrl: CONFIRMATION_URL }),
    );

    expect(html).toContain(CONFIRMATION_URL);
  });
});
