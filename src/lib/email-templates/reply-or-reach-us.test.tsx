// No email may promise a reply that reaches nobody.
//
// Every club email comes from `noreply@`. A reply reaches a person only when
// the club has set a reply-to address, so each line that says "reply to this
// email" has to switch to the contact page, phone and WhatsApp when there is
// none. This renders every template that has such a line, both ways round.
import * as React from "react";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { ContactConfirmationEmail } from "./contact-confirmation";
import { ItemInvoiceEmail } from "./item-invoice";
import { ItemInvoicePaidEmail } from "./item-invoice-paid";
import { MembershipPaidEmail } from "./membership-paid";
import { MembershipPaymentEmail } from "./membership-payment";
import { WaiverConfirmationEmail } from "./waiver-confirmation";
import { clubPaymentDetailsSchema } from "@/lib/validation";
import { VENUE_PHONE_DISPLAY } from "@/lib/venue";

const SITE = { siteName: "UTS Jitsu", siteUrl: "https://jitsu.au" };
const DETAILS = clubPaymentDetailsSchema.parse({
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
});

const visibleText = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Each email with a reply line, as a function of the reply-to it was sent with. */
const EMAILS: Record<string, (replyTo: string | null) => React.ReactElement> = {
  "membership invoice": (replyTo) =>
    React.createElement(MembershipPaymentEmail, {
      ...SITE,
      memberName: "Ada",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      details: DETAILS,
      membershipUrl: "https://jitsu.au/membership",
      replyTo,
    }),
  "membership invoice, account not published": (replyTo) =>
    React.createElement(MembershipPaymentEmail, {
      ...SITE,
      memberName: "Ada",
      planName: "One semester",
      amount: "$245",
      reference: "UTSJ-ABC234",
      details: null,
      membershipUrl: "https://jitsu.au/membership",
      replyTo,
    }),
  "item invoice": (replyTo) =>
    React.createElement(ItemInvoiceEmail, {
      ...SITE,
      memberName: "Ada",
      lines: [{ description: "Club gi", amount: "$85" }],
      total: "$85",
      reference: "INV0007",
      details: DETAILS,
      membershipUrl: "https://jitsu.au/membership",
      replyTo,
    }),
  "membership receipt": (replyTo) =>
    React.createElement(MembershipPaidEmail, {
      ...SITE,
      memberName: "Ada",
      planName: "One semester",
      validity: "Valid for 182 days.",
      amount: "$245",
      accountUrl: "https://jitsu.au/membership",
      replyTo,
    }),
  "item invoice receipt": (replyTo) =>
    React.createElement(ItemInvoicePaidEmail, {
      ...SITE,
      memberName: "Ada",
      reference: "INV0007",
      summary: "Club gi",
      amount: "$85",
      membershipUrl: "https://jitsu.au/membership",
      replyTo,
    }),
  "waiver confirmation with no PDF": (replyTo) =>
    React.createElement(WaiverConfirmationEmail, {
      ...SITE,
      memberName: "Ada",
      pdfUrl: null,
      replyTo,
    }),
};

describe.each(Object.entries(EMAILS))("%s", (_name, email) => {
  it("offers a reply when replies reach the club", async () => {
    const html = await render(email("hello@example.com"));
    expect(visibleText(html)).toMatch(/reply to this email/i);
    expect(html).not.toContain("https://jitsu.au/contact");
  });

  it("points at the contact page, phone and WhatsApp when they do not", async () => {
    const html = await render(email(null));
    const text = visibleText(html);
    expect(text).not.toMatch(/reply to this email/i);
    expect(html).toContain('href="https://jitsu.au/contact"');
    expect(text).toContain(VENUE_PHONE_DISPLAY);
    expect(text).toContain("WhatsApp");
  });
});

describe("contact form acknowledgement", () => {
  const ack = (replyTo: string | null) =>
    render(
      React.createElement(ContactConfirmationEmail, {
        ...SITE,
        name: "Ada",
        message: "Do you run a kids class?",
        phoneDisplay: VENUE_PHONE_DISPLAY,
        phoneTel: "tel:0400000000",
        whatsappUrl: "https://wa.me/61400000000",
        replyTo,
      }),
    );

  it("only implies a reply is read when one would be", async () => {
    expect(visibleText(await ack("hello@example.com"))).toMatch(/no need to reply/i);
    const unset = visibleText(await ack(null));
    expect(unset).not.toMatch(/no need to reply/i);
    expect(unset).toMatch(/replies to this address are not read/i);
  });
});
