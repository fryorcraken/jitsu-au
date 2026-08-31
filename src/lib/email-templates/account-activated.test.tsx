import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { AccountActivatedEmail } from "./account-activated";

const PROPS = {
  siteName: "UTS Jitsu",
  siteUrl: "https://jitsu.au",
  memberName: "Thirteen",
  loginEmail: "sensei+13@sydneyjitsu.com.au",
  signInUrl: "https://jitsu.au/auth",
  kbUrl: "https://jitsu.au/kb",
  codeOfConductUrl: "https://jitsu.au/code-of-conduct",
  membershipUrl: "https://jitsu.au/membership",
  blogUrl: "https://jitsu.au/blog",
  contactUrl: "https://jitsu.au/contact",
};

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
// The apostrophes are entity-escaped on the way out, so they are decoded here
// too: an assertion should read like the sentence a person sees, not like the
// markup around it.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const renderHtml = (props: object = PROPS) =>
  render(React.createElement(AccountActivatedEmail, { ...PROPS, ...props }));

describe("AccountActivatedEmail", () => {
  // Approving a child's waiver unlocks their PARENT's login, because the child
  // has none and never will (#102). So this email goes to somebody who may not
  // be training at all, and it has to say whose waiver it is about.
  describe("when the account was opened by approving a dependant's waiver", () => {
    it("names the child and does not claim the reader's own waiver was approved", async () => {
      const text = visibleText(await renderHtml({ memberName: "Ada", dependantName: "Bea" }));
      expect(text).toContain("Hi Ada");
      expect(text).toContain("Bea's waiver has been approved");
      expect(text).toContain("Bea is cleared to train");
      // The sentence for somebody signing for themselves must not survive:
      // a parent reading "you're cleared to train" about a form they filled in
      // for their nine-year-old is being told something untrue.
      expect(text).not.toContain("your waiver has been approved");
      expect(text).not.toContain("You're cleared to train");
    });

    it("still names the address the login is keyed on", async () => {
      // The whole point of the email: it carries no sign-in link, so the
      // address is the only way in.
      const text = visibleText(await renderHtml({ memberName: "Ada", dependantName: "Bea" }));
      expect(text).toContain("sensei+13@sydneyjitsu.com.au");
    });

    it("asks them to agree to the code of conduct on the child's behalf", async () => {
      const text = visibleText(await renderHtml({ memberName: "Ada", dependantName: "Bea" }));
      expect(text).toContain("on Bea's behalf");
    });
  });

  it("reads exactly as it always has for somebody signing for themselves", async () => {
    // The default, and the common case. `dependantName` absent must change
    // nothing at all.
    const text = visibleText(await renderHtml({ dependantName: null }));
    expect(text).toContain("your waiver has been approved");
    expect(text).toContain("Your membership");
  });

  it("tells them the account is open and names the address to sign in with", async () => {
    const text = visibleText(await renderHtml());
    expect(text).toContain("Your account is active");
    expect(text).toContain("Hi Thirteen");
    expect(text).toContain("sensei+13@sydneyjitsu.com.au");
    expect(text).toMatch(/your login is/i);
  });

  it("points at the sign-in page", async () => {
    expect(await renderHtml()).toContain('href="https://jitsu.au/auth"');
  });

  // The whole reason this email replaced the magic link: an unrequested
  // one-time link expires in an hour, so it is usually dead by the time a new
  // member reads it. Every URL here has to be a plain page that still works
  // next week. A token creeping back in would silently restore the old
  // failure, and it would only ever be noticed by the member who got locked out.
  it("carries no single-use sign-in token", async () => {
    const html = await renderHtml();
    expect(html).not.toMatch(/token|access_token|otp|magiclink|confirmation_url/i);
    for (const href of html.match(/href="[^"]*"/g) ?? []) {
      expect(href).not.toContain("?");
    }
  });

  it("invites them into the rest of the member area", async () => {
    const html = await renderHtml();
    const text = visibleText(html);
    expect(text).toContain("code of conduct");
    expect(text).toMatch(/invoices/i);
    expect(text).toContain("blog");
    expect(text).toContain("knowledge base");
    for (const url of [PROPS.codeOfConductUrl, PROPS.membershipUrl, PROPS.blogUrl, PROPS.kbUrl]) {
      expect(html).toContain(`href="${url}"`);
    }
  });

  // Deliberate running order, not incidental. The code of conduct is the one
  // thing this email asks of them, so it leads; the membership is what they
  // will come back for; the blog is the invitation to stick around. The
  // knowledge base is mentioned last and without a heading of its own, because
  // it is the biggest thing back there and would swamp the two that matter on
  // day one.
  it("keeps the code of conduct first and the knowledge base a passing mention", async () => {
    const text = visibleText(await renderHtml());
    const order = ["code of conduct", "membership", "blog", "knowledge base"].map((phrase) =>
      text.toLowerCase().indexOf(phrase),
    );
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // A passing mention: no "What's waiting" style heading introduces it.
    expect(text).not.toMatch(/The knowledge base\./);
  });

  // Every email here goes out from noreply@ with no reply-to header, so the
  // "just reply" sign-off other templates use would swallow the one message
  // that matters most: a new member saying they cannot get in.
  it("offers a route back that actually reaches the club", async () => {
    const html = await renderHtml();
    expect(html).toContain('href="https://jitsu.au/contact"');
    expect(visibleText(html)).not.toMatch(/reply to this email/i);
  });

  it("greets someone with no name on file without leaving a gap", async () => {
    const text = visibleText(await renderHtml({ memberName: "" }));
    expect(text).toContain("Hi there,");
  });

  // House style for member-facing copy (AGENTS.md): no em dashes in prose.
  it("keeps em dashes out of the copy", async () => {
    expect(visibleText(await renderHtml())).not.toContain("—");
  });
});
