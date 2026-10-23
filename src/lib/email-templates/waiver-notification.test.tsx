// The managers' "new waiver" email for a waiver a parent signed for their
// child. The address it carries, and its Reply-To, are the parent's, so it has
// to say the parent signed and who for. Printed bare after the child's name the
// address reads as the child's own, and a manager's reply opens "Hi Sam" to
// Sam's mother.
import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { WaiverNotificationEmail } from "./waiver-notification";

const PROPS = {
  siteName: "UTS Jitsu",
  memberName: "Sam Lovelace",
  memberEmail: "ada@example.com",
  pdfUrl: "https://example.com/waiver.pdf",
  reviewUrl: "https://jitsu.au/manager/waivers",
};

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const renderText = async (props: object = {}) =>
  visibleText(await render(React.createElement(WaiverNotificationEmail, { ...PROPS, ...props })));

describe("WaiverNotificationEmail", () => {
  it("names the parent as the signer and the child as who it is for", async () => {
    const text = await renderText({ signedByName: "Ada Lovelace" });

    expect(text).toContain(
      "Ada Lovelace ( ada@example.com ) just signed a training waiver for Sam Lovelace at UTS Jitsu.",
    );
    expect(text).toContain("New waiver signed by Ada Lovelace for Sam Lovelace: UTS Jitsu");
  });

  it("names the member as the signer on a waiver they signed themselves", async () => {
    const text = await renderText({ memberName: "Ada Lovelace" });

    expect(text).toContain(
      "Ada Lovelace ( ada@example.com ) just signed a training waiver for UTS Jitsu.",
    );
    expect(text).toContain("New waiver signed by Ada Lovelace: UTS Jitsu");
  });
});
