// The item invoice asks for money into the club's account, so it has to carry
// the same bank details the membership invoice does, and everything a member
// needs to pay without opening the site: each line, the total and the
// reference.
import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { ItemInvoiceEmail } from "./item-invoice";
import { ItemInvoicePaidEmail } from "./item-invoice-paid";
import { clubPaymentDetailsSchema } from "@/lib/validation";

const DETAILS = clubPaymentDetailsSchema.parse({
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
});

const PROPS = {
  siteName: "UTS Jitsu",
  siteUrl: "https://jitsu.au",
  memberName: "Ada",
  lines: [
    { description: "Club gi", amount: "$85" },
    { description: "2 × Club patch", amount: "$25" },
  ],
  total: "$110",
  reference: "INV0007",
  details: DETAILS,
  membershipUrl: "https://jitsu.au/membership",
};

const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    // React escapes an apostrophe, and the copy is full of possessives.
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const renderInvoice = (props: object = {}) =>
  render(React.createElement(ItemInvoiceEmail, { ...PROPS, ...props }));

describe("ItemInvoiceEmail", () => {
  it("lists every line, the total and the reference", async () => {
    const text = visibleText(await renderInvoice());
    expect(text).toContain("Club gi");
    expect(text).toContain("2 × Club patch");
    expect(text).toContain("$110");
    expect(text).toContain("INV0007");
  });

  it("carries the club's account, the same block as the membership invoice", async () => {
    const text = visibleText(await renderInvoice());
    expect(text).toContain("UTS Jitsu Club Inc");
    expect(text).toContain("062-000");
    expect(text).toContain("12345678");
  });

  it("says the details are not published yet rather than printing an empty block", async () => {
    const text = visibleText(await renderInvoice({ details: null }));
    expect(text).toMatch(/have not published our account details yet/i);
    expect(text).toContain("INV0007");
    expect(text).not.toContain("12345678");
  });

  // One inbox, several children: the parent has to be told whose it is.
  it("names the child when it is not the reader's own invoice", async () => {
    const text = visibleText(await renderInvoice({ forName: "Bea" }));
    expect(text).toContain("here is Bea's invoice");
  });

  // The club is not registered for GST, so the email must not claim to be a
  // tax invoice.
  it("does not call itself a tax invoice", async () => {
    const text = visibleText(await renderInvoice());
    expect(text).not.toMatch(/tax invoice|GST|ABN/i);
  });

  it("links to the membership page, where the values have copy buttons", async () => {
    expect(await renderInvoice()).toContain("https://jitsu.au/membership");
  });
});

describe("ItemInvoicePaidEmail", () => {
  it("confirms the amount against the invoice it settles", async () => {
    const text = visibleText(
      await render(
        React.createElement(ItemInvoicePaidEmail, {
          siteName: "UTS Jitsu",
          siteUrl: "https://jitsu.au",
          memberName: "Ada",
          forName: "Bea",
          reference: "INV0007",
          summary: "Club gi",
          amount: "$85",
          membershipUrl: "https://jitsu.au/membership",
        }),
      ),
    );
    expect(text).toContain("$85");
    expect(text).toContain("Bea's");
    expect(text).toContain("INV0007");
    expect(text).toMatch(/nothing left to pay/);
  });
});
