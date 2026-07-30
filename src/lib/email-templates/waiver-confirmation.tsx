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

interface WaiverConfirmationEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  /**
   * Null when the copy could not be produced. The waiver is signed and recorded
   * either way, so this email still goes out. Silence would leave the signer
   * with nothing at all, which is how someone ends up signing a second time.
   */
  pdfUrl: string | null;
  /**
   * Present only when the signer's address has not been proven yet. Someone who
   * came from their interest email is already verified and must not be asked to
   * confirm what they just confirmed.
   */
  verifyUrl?: string | null;
}

/** Sent to the person who just signed a waiver, with a link to their PDF copy. */
export const WaiverConfirmationEmail = ({
  siteName,
  siteUrl,
  memberName,
  pdfUrl,
  verifyUrl,
}: WaiverConfirmationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your {siteName} training waiver</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Thanks for signing your waiver</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, we&apos;ve received your training waiver for{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          .
          {pdfUrl
            ? " A copy is attached as a PDF via the secure link below."
            : " We had trouble preparing your PDF copy, so there is no download link here. Your waiver is signed and saved, and there is no need to sign again. Reply to this email if you would like a copy and we will sort it out."}
        </Text>
        {pdfUrl && (
          <Button style={button} href={pdfUrl}>
            Download your waiver (PDF)
          </Button>
        )}
        <Text style={text}>
          A manager will review your submission. You&apos;ll be cleared to train once it&apos;s
          approved.
        </Text>
        {verifyUrl ? (
          <>
            <Text style={text}>
              One last thing. Tap below so we know we can reach you at this address. That&apos;s
              where your approval and sign-in link will go.
            </Text>
            <Button style={button} href={verifyUrl}>
              Confirm your email address
            </Button>
          </>
        ) : null}
        <Text style={footer}>
          This download link expires after a few days. If it stops working, sign in to your account
          to view your waiver again.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default WaiverConfirmationEmail;

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
