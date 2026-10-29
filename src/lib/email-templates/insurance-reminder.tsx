import * as React from "react";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

interface InsuranceReminderEmailProps {
  siteName: string;
  /** "Hi Ada": the person reading it, who for a child is their parent. */
  greeting: string;
  /** From `insuranceReminderCopy`, which also writes the subject. */
  heading: string;
  body: string;
  /** Absolute link to the Membership page, opened on the right person. */
  renewUrl: string;
}

/**
 * Sent 14 days before somebody's yearly insurance ends, and on the day it ends.
 *
 * No settings link, unlike the notification emails: there is no switch for
 * this one (it is about their membership, like an invoice), and a link to a
 * page of switches would promise a choice the page does not offer.
 */
export const InsuranceReminderEmail = ({
  siteName,
  greeting,
  heading,
  body,
  renewUrl,
}: InsuranceReminderEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{heading}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{heading}</Heading>
        <Text style={text}>{greeting},</Text>
        <Text style={text}>{body}</Text>
        <Button style={button} href={renewUrl}>
          Renew on the Membership page
        </Button>
        <Text style={footer}>
          {siteName} sends this to everyone whose yearly insurance is ending, because it is part of
          their membership.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default InsuranceReminderEmail;

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
  margin: "0 0 15px",
};
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
