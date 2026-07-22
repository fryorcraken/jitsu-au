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

interface MembershipNotificationEmailProps {
  siteName: string;
  memberName: string;
  memberEmail: string;
  planName: string;
  amount: string;
  reference: string;
  reviewUrl: string;
}

/** Sent to managers when a member selects a paid plan and owes a bank transfer. */
export const MembershipNotificationEmail = ({
  siteName,
  memberName,
  memberEmail,
  planName,
  amount,
  reference,
  reviewUrl,
}: MembershipNotificationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {memberName || memberEmail} owes {amount} for {planName}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>New membership pending payment</Heading>
        <Text style={text}>
          <strong>{memberName || "A member"}</strong> ({memberEmail}) selected{" "}
          <strong>{planName}</strong> at {siteName} and owes <strong>{amount}</strong>.
        </Text>
        <Text style={text}>
          Payment reference: <strong>{reference}</strong>. It will auto-reconcile when you import a
          bank statement containing this reference and amount.
        </Text>
        <Button style={button} href={reviewUrl}>
          Review memberships
        </Button>
      </Container>
    </Body>
  </Html>
);

export default MembershipNotificationEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
};
