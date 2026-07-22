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

interface MembershipActivatedEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  planName: string;
  /** Human-readable validity/credit summary, e.g. "Valid until 12 Dec 2026" or "2 sessions". */
  validity: string;
  accountUrl: string;
}

/** Sent once a membership payment is reconciled and the membership goes active. */
export const MembershipActivatedEmail = ({
  siteName,
  siteUrl,
  memberName,
  planName,
  validity,
  accountUrl,
}: MembershipActivatedEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your {planName} is active</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>You're all set — welcome to the mat</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, your <strong>{planName}</strong> at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>{" "}
          is now active. {validity}
        </Text>
        <Button style={button} href={accountUrl}>
          View your membership
        </Button>
        <Text style={footer}>See you in class. Reply to this email if anything looks off.</Text>
      </Container>
    </Body>
  </Html>
);

export default MembershipActivatedEmail;

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
