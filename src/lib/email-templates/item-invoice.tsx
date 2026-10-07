import * as React from "react";

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ClubPaymentDetails } from "@/lib/validation";
import { ClubAccountSection } from "./club-account-section";
import {
  emailHr as hr,
  emailRowLabel as rowLabel,
  emailRowValue as rowValue,
} from "./invoice-styles";

/** One line as the email prints it: already described and already totalled. */
export type ItemInvoiceEmailLine = { description: string; amount: string };

interface ItemInvoiceEmailProps {
  siteName: string;
  siteUrl: string;
  /** The greeting: whoever reads this inbox. */
  memberName: string;
  /**
   * The person the invoice is FOR, when that is not the person reading it. A
   * parent has one inbox and possibly several children, so an invoice that
   * named nobody would leave them guessing whose gi this is.
   */
  forName?: string | null;
  lines: ItemInvoiceEmailLine[];
  total: string;
  reference: string;
  /** The club's bank account, or null when it has not published one. */
  details: ClubPaymentDetails | null;
  /** Where the member can read the same invoice, with copy buttons. */
  membershipUrl: string;
}

/**
 * An invoice for things on the club's price list (a gi, a patch, a grading
 * fee), raised by a manager. The club's bank details are the same block the
 * membership invoice prints, from the same component, so the two can never ask
 * for money into different accounts.
 *
 * Not a tax invoice, and it does not say it is one: the club is not registered
 * for GST, so there is no ABN or GST line to print.
 */
export const ItemInvoiceEmail = ({
  siteName,
  siteUrl,
  memberName,
  forName,
  lines,
  total,
  reference,
  details,
  membershipUrl,
}: ItemInvoiceEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      Invoice {reference} from {siteName}: {total}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Invoice {reference}</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, here is {forName ? `${forName}'s` : "your"} invoice from{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          . Please pay <strong>{total}</strong> using the details below.
        </Text>

        <Section style={box}>
          {lines.map((line, i) => (
            <Text key={i} style={lineRow}>
              {line.description}
              <span style={lineAmount}>{line.amount}</span>
            </Text>
          ))}
          <Hr style={hr} />
          <Text style={rowLabel}>Total</Text>
          <Text style={rowValue}>{total}</Text>
          <Hr style={hr} />
          <Text style={rowLabel}>Payment reference (important)</Text>
          <Text style={reference_}>{reference}</Text>
        </Section>

        <ClubAccountSection details={details} />

        <Text style={text}>
          <strong>Please include the payment reference in your transfer description.</strong> It's
          how we match your payment to this invoice. We'll email you a receipt once it lands.
        </Text>
        <Text style={text}>
          You can see this invoice any time on your{" "}
          <Link href={membershipUrl} style={link}>
            membership page
          </Link>
          , where each detail has a copy button.
        </Text>
        <Text style={footer}>
          Paying a different way or already paid? Just reply to this email and we'll sort it out.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default ItemInvoiceEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
const link = { color: "inherit", textDecoration: "underline" };
const box = {
  backgroundColor: "#f4f7f8",
  borderRadius: "8px",
  padding: "16px 20px",
  margin: "0 0 20px",
};
const lineRow = { fontSize: "14px", color: "#222222", margin: "4px 0" };
// Floated rather than a table: a two-column layout is the part of an email most
// likely to fall apart in a phone mail client, and this degrades to one line.
const lineAmount = { float: "right" as const, fontWeight: "bold" as const };
const reference_ = {
  fontSize: "20px",
  color: "#008eaa",
  fontWeight: "bold" as const,
  letterSpacing: "0.06em",
  margin: "2px 0 0",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
