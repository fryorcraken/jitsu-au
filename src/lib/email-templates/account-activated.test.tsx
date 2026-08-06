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
};

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const renderHtml = (props: object = PROPS) =>
  render(React.createElement(AccountActivatedEmail, { ...PROPS, ...props }));

describe("AccountActivatedEmail", () => {
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
    expect(text).toContain("knowledge base");
    expect(text).toContain("code of conduct");
    expect(text).toMatch(/invoices/i);
    expect(text).toContain("blog");
    for (const url of [PROPS.kbUrl, PROPS.codeOfConductUrl, PROPS.membershipUrl, PROPS.blogUrl]) {
      expect(html).toContain(`href="${url}"`);
    }
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
