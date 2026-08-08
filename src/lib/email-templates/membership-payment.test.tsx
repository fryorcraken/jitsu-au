// The invoice email and the "how to pay" panel are two views of ONE set of
// values, kept in step by walking the same field list. That is the rule these
// tests exist to hold: the sharing is real, but nothing asserted the email
// actually rendered it, so a change to the list or to this template could quietly
// leave the two quoting different bank details.
import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { MembershipPaymentEmail } from "./membership-payment";
import { CLUB_ACCOUNT_FIELDS, clubPaymentDetailsSchema } from "@/lib/validation";

const DETAILS = clubPaymentDetailsSchema.parse({
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
});

const OVERSEAS = clubPaymentDetailsSchema.parse({
  ...DETAILS,
  swift_bic: "CTBAAU2S",
  bank_address: "Sydney NSW 2000, Australia",
  account_holder_address: "1 Broadway, Ultimo NSW 2007, Australia",
});

const PROPS = {
  siteName: "UTS Jitsu",
  siteUrl: "https://jitsu.au",
  memberName: "Ada",
  planName: "Semester 2 2026",
  amount: "$245",
  reference: "UTSJ-LOVE-A1B2",
  details: DETAILS,
  membershipUrl: "https://jitsu.au/membership",
};

// react-dom/server splits interpolated text with <!-- --> markers, so compare
// against the visible copy rather than the raw markup.
const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const renderHtml = (props: object = {}) =>
  render(React.createElement(MembershipPaymentEmail, { ...PROPS, ...props }));

describe("MembershipPaymentEmail", () => {
  it("carries the amount, the reference and the club's account", async () => {
    const text = visibleText(await renderHtml());
    expect(text).toContain("$245");
    expect(text).toContain("UTSJ-LOVE-A1B2");
    expect(text).toContain("UTS Jitsu Club Inc");
    expect(text).toContain("12345678");
    expect(text).toContain("Commonwealth Bank of Australia");
  });

  // The BSB is stored as six bare digits and hyphenated in exactly one place.
  // If the email ever printed the raw value, it would disagree with both the
  // page and what a member copied off it.
  it("prints the BSB hyphenated, the same as the page and the clipboard", async () => {
    const text = visibleText(await renderHtml());
    expect(text).toContain("062-000");
    expect(text).not.toContain("062000");
  });

  // Adding a field to the shared list without teaching the email about it should
  // be a failing test, not a silent divergence between the email and the page.
  it("renders every field the shared list defines", async () => {
    const text = visibleText(await renderHtml());
    for (const field of CLUB_ACCOUNT_FIELDS) {
      expect(text).toContain(field.label);
    }
  });

  it("adds the overseas block, and the warning about fees, when there is one", async () => {
    const text = visibleText(await renderHtml({ details: OVERSEAS }));
    expect(text).toContain("Paying from overseas");
    expect(text).toContain("CTBAAU2S");
    expect(text).toContain("Sydney NSW 2000, Australia");
    expect(text).toContain("1 Broadway, Ultimo NSW 2007, Australia");
    // Not decoration: a fee-shortened transfer does not auto-reconcile.
    expect(text).toMatch(/take fees out of an international transfer/i);
  });

  it("leaves the overseas block out entirely when the club has not filled it in", async () => {
    const text = visibleText(await renderHtml());
    expect(text).not.toContain("Paying from overseas");
    expect(text).not.toMatch(/SWIFT/i);
  });

  it("renders the club's note when there is one", async () => {
    const withNote = { ...DETAILS, note: "Prefer PayID? Send to pay@jitsu.au." };
    const text = visibleText(await renderHtml({ details: withNote }));
    expect(text).toContain("Prefer PayID? Send to pay@jitsu.au.");
  });

  // Between this shipping and a manager filling the form in, there is no account
  // to name. The email must say so rather than print an empty block.
  it("says the details are not published yet rather than printing an empty block", async () => {
    const text = visibleText(await renderHtml({ details: null }));
    expect(text).toMatch(/have not published our account details yet/i);
    // The member's own data still renders: they can see what they owe.
    expect(text).toContain("$245");
    expect(text).toContain("UTSJ-LOVE-A1B2");
    // But nothing bank-shaped leaks through.
    expect(text).not.toContain("062-000");
    expect(text).not.toContain("12345678");
    expect(text).not.toContain("UTS Jitsu Club Inc");
  });

  it("points at the page, where the values have copy buttons", async () => {
    const html = await renderHtml();
    expect(html).toContain("https://jitsu.au/membership");
  });
});
