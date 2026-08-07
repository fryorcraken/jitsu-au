import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

interface ContactConfirmationEmailProps {
  siteName: string;
  siteUrl: string;
  name: string;
  subject?: string | null;
  /** Their message, quoted back so they keep a copy of what they sent. */
  message: string;
  /** Displayed form of the club's phone, e.g. "0493 631 759". */
  phoneDisplay: string;
  /** `tel:` href for the same number. */
  phoneTel: string;
  whatsappUrl: string;
}

/**
 * Sent to someone who has just used the contact form. It confirms a real person
 * will read it, quotes their message back, and offers the faster channels for
 * anything that cannot wait. Deliberately makes no promise about how quickly
 * the club replies, because nothing in the system enforces one.
 */
export const ContactConfirmationEmail = ({
  siteName,
  siteUrl,
  name,
  subject,
  message,
  phoneDisplay,
  phoneTel,
  whatsappUrl,
}: ContactConfirmationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>We got your message. Here&apos;s a copy for your records.</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Thanks, we got your message</Heading>
        <Text style={text}>
          Hi {name || "there"}, your message reached{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>{" "}
          and one of our instructors will get back to you.
        </Text>
        <Text style={text}>Here&apos;s what you sent, so you have a copy:</Text>
        <Container style={quote}>
          {subject ? (
            <Text style={quoteSubject}>
              <strong>{subject}</strong>
            </Text>
          ) : null}
          <Text style={quoteBody}>{message}</Text>
        </Container>
        <Text style={text}>
          If it&apos;s urgent, we&apos;re quicker on the phone. Call or text{" "}
          <Link href={phoneTel} style={link}>
            {phoneDisplay}
          </Link>
          , or message us on{" "}
          <Link href={whatsappUrl} style={link}>
            WhatsApp
          </Link>
          .
        </Text>
        <Text style={footer}>
          You&apos;re receiving this because you sent a message through the contact form at{" "}
          {siteName}. No need to reply to this address if you were just after a copy.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default ContactConfirmationEmail;

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
// The quoted message. Bordered rather than italic so a long message stays
// readable, and `whiteSpace: pre-wrap` keeps the line breaks they typed.
const quote = {
  borderLeft: "3px solid #d6d8db",
  padding: "2px 0 2px 15px",
  margin: "0 0 25px",
};
const quoteSubject = { fontSize: "14px", color: "#55575d", margin: "0 0 8px" };
const quoteBody = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0",
  whiteSpace: "pre-wrap" as const,
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
