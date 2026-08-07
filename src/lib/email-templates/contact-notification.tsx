import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

interface ContactNotificationEmailProps {
  siteName: string;
  name: string;
  email: string;
  subject?: string | null;
  message: string;
  /** Manager screen listing every message received. */
  inboxUrl: string;
}

/**
 * Sent to managers when someone uses the contact form. The sender's address is a
 * mailto link because replying from your own inbox is the whole workflow: the
 * site has no reply-from-the-dashboard screen and does not need one.
 */
export const ContactNotificationEmail = ({
  siteName,
  name,
  email,
  subject,
  message,
  inboxUrl,
}: ContactNotificationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      New contact form message from {name || email}
      {subject ? `: ${subject}` : ""}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>New message from the contact form</Heading>
        <Text style={text}>
          <strong>{name || "Someone"}</strong> sent {siteName} a message.
        </Text>
        <Text style={text}>
          <strong>Name:</strong> {name || "(not given)"}
          <br />
          <strong>Email:</strong>{" "}
          <Link href={`mailto:${email}`} style={link}>
            {email}
          </Link>
          <br />
          <strong>Subject:</strong> {subject || "(none)"}
        </Text>
        <Container style={quote}>
          <Text style={quoteBody}>{message}</Text>
        </Container>
        <Text style={text}>
          Reply straight to{" "}
          <Link href={`mailto:${email}`} style={link}>
            {email}
          </Link>
          . Every message is also listed here:
        </Text>
        <Text style={text}>
          <Link href={inboxUrl} style={link}>
            {inboxUrl}
          </Link>
        </Text>
        <Text style={footer}>
          You&apos;re receiving this because you&apos;re a manager of {siteName}.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default ContactNotificationEmail;

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
// `whiteSpace: pre-wrap` keeps the sender's own line breaks, which matters when
// someone lays out a question in a list.
const quote = {
  borderLeft: "3px solid #d6d8db",
  padding: "2px 0 2px 15px",
  margin: "0 0 25px",
};
const quoteBody = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0",
  whiteSpace: "pre-wrap" as const,
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
