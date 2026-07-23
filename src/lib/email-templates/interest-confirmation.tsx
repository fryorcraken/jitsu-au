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

interface InterestConfirmationEmailProps {
  siteName: string;
  siteUrl: string;
  name: string;
  /** Prefilled waiver link carrying the lead's name/email/phone. */
  waiverUrl: string;
}

/**
 * Sent to someone who just registered their interest ("Start your free trial"
 * step 1). Nudges them to sign their waiver next via a prefilled link.
 */
export const InterestConfirmationEmail = ({
  siteName,
  siteUrl,
  name,
  waiverUrl,
}: InterestConfirmationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>You&apos;re on the list. Sign your waiver to be mat-ready.</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>You&apos;re on the list</Heading>
        <Text style={text}>
          Hi {name || "there"}, thanks for registering your interest in training at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          . Your first two classes are free, no gear needed.
        </Text>
        <Text style={text}>
          One thing left to be mat-ready: sign your training waiver. We&apos;ve filled in your
          details to save you time, so it only takes a couple of minutes.
        </Text>
        <Button style={button} href={waiverUrl}>
          Sign my waiver
        </Button>
        <Text style={text}>
          Not ready? No problem. Just turn up to any beginners class (Mon or Wed) and we&apos;ll
          sort it at the gym.
        </Text>
        <Text style={footer}>
          You&apos;re receiving this because you registered your interest at {siteName}.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default InterestConfirmationEmail;

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
