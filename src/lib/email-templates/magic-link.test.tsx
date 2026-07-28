import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { LOGIN_LINK_VALIDITY_MINUTES, MagicLinkEmail } from "./magic-link";

const renderEmail = () =>
  render(
    React.createElement(MagicLinkEmail, {
      siteName: "UTS Jitsu",
      confirmationUrl: "https://jitsu.au/auth/confirm?token=abc",
    }),
  );

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("MagicLinkEmail", () => {
  it("states how long the login link is valid for", async () => {
    const html = await renderEmail();

    // The plain "expire shortly" copy left people guessing; the email must name
    // the window, and it must be the same one Supabase is configured with.
    expect(LOGIN_LINK_VALIDITY_MINUTES).toBe(10);
    expect(visibleText(html)).toContain(
      `The link is valid for ${LOGIN_LINK_VALIDITY_MINUTES} minutes`,
    );
  });

  it("links the button at the confirmation url", async () => {
    const html = await renderEmail();

    expect(html).toContain("https://jitsu.au/auth/confirm?token=abc");
  });
});
