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

import { waiverNotificationSubject } from "./waiver-notification-subject";

interface WaiverNotificationEmailProps {
  siteName: string;
  /** Who the waiver is for: the person a manager is about to review. */
  memberName: string;
  memberEmail: string;
  /**
   * The parent who signed, on a waiver signed for a child on their account.
   *
   * The address in this email (and its Reply-To) is the parent's, so it names
   * the parent as the signer and the child as who it is for. Printed bare after
   * the child's name, the address reads as the child's own, and a manager
   * pressing reply would start "Hi Sam" to Sam's mother. Null on a waiver
   * somebody signed for themselves, a minor co-signed by a guardian included.
   */
  signedByName?: string | null;
  /**
   * Null when the copy could not be produced. The waiver is still signed and
   * recorded, so this email still goes out: a manager knowing to chase a missing
   * document is the whole point of sending it.
   */
  pdfUrl: string | null;
  reviewUrl: string;
}

/** Sent to managers when a new waiver is signed, with the PDF and a review link. */
export const WaiverNotificationEmail = ({
  siteName,
  memberName,
  memberEmail,
  signedByName,
  pdfUrl,
  reviewUrl,
}: WaiverNotificationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {waiverNotificationSubject({ memberName, memberEmail, signedByName })}: {siteName}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>New waiver to review</Heading>
        <Text style={text}>
          <strong>{signedByName || memberName || "A new member"}</strong> (
          <Link href={`mailto:${memberEmail}`} style={link}>
            {memberEmail}
          </Link>
          ) just signed a training waiver
          {signedByName ? (
            <>
              {" "}
              for <strong>{memberName}</strong> at {siteName}.
            </>
          ) : (
            ` for ${siteName}.`
          )}
          {pdfUrl
            ? " The signed PDF is available via the secure link below."
            : " We could not produce the PDF copy this time, so there is no download link. The waiver itself is recorded. Please get in touch with them to sort out a copy."}
        </Text>
        {pdfUrl && (
          <Button style={button} href={pdfUrl}>
            Download the signed waiver (PDF)
          </Button>
        )}
        <Text style={text}>Review it and approve the member in the manager dashboard:</Text>
        <Text style={text}>
          <Link href={reviewUrl} style={link}>
            {reviewUrl}
          </Link>
        </Text>
        <Text style={footer}>
          You&apos;re receiving this because you&apos;re a manager of {siteName}.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default WaiverNotificationEmail;

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
