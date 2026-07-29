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

interface VerifyEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  verifyUrl: string;
}

/**
 * The standalone "confirm your email address" email.
 *
 * Sent when someone asks for it: a manager pressing resend, a member pressing
 * send on their account page, or a manager correcting an address. The same
 * button also appears inside the waiver confirmation email, so most people
 * never see this one.
 */
export const VerifyEmail = ({ siteName, siteUrl, memberName, verifyUrl }: VerifyEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Confirm your email address</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Confirm your email address</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, tap below so we know we can reach you at this address. It
          means your class updates and sign-in links from{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>{" "}
          land where they should.
        </Text>
        <Button style={button} href={verifyUrl}>
          Confirm your email address
        </Button>
        <Text style={footer}>
          If you weren&apos;t expecting this, you can ignore it. Nothing changes until you tap the
          button.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default VerifyEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = {
  fontSize: "22px",
  fontWeight: "bold" as const,
  color: "#008eaa",
  margin: "0 0 20px",
};
const text = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 25px",
};
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
