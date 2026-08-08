import * as React from "react";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";

interface MembershipPaidEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  planName: string;
  /** Human-readable validity/credit summary, e.g. "Valid until 12 Dec 2026" or "2 sessions". */
  validity: string;
  /** What they paid, already formatted. */
  amount: string;
  accountUrl: string;
}

/**
 * Sent when a payment is recorded against a membership, by bank reconciliation
 * or by a manager marking it paid.
 *
 * It is a receipt, not a welcome. Being allowed to train is settled when the
 * membership is raised, and the invoice email says so at the time, so this
 * email's whole job is to confirm the money arrived and nothing is outstanding.
 */
export const MembershipPaidEmail = ({
  siteName,
  siteUrl,
  memberName,
  planName,
  validity,
  amount,
  accountUrl,
}: MembershipPaidEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>We received your payment for {planName}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Payment received, thank you</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, we have received {amount} for your <strong>{planName}</strong>{" "}
          at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          . There is nothing left to pay on it. {validity}
        </Text>
        <Button style={button} href={accountUrl}>
          View your membership
        </Button>
        <Text style={footer}>See you in class. Reply to this email if anything looks off.</Text>
      </Container>
    </Body>
  </Html>
);

export default MembershipPaidEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
const link = { color: "inherit", textDecoration: "underline" };
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
