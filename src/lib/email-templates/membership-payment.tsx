import * as React from "react";

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import ReactMarkdown from "react-markdown";

interface MembershipPaymentEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  planName: string;
  amount: string;
  reference: string;
  /** Manager-set markdown payment instructions (bank details, PayID, etc.). */
  instructions: string;
}

/**
 * The membership invoice. Carries the computed amount + unique payment reference
 * (so the transfer auto-reconciles) and renders the club's manager-set markdown
 * payment instructions.
 */
export const MembershipPaymentEmail = ({
  siteName,
  siteUrl,
  memberName,
  planName,
  amount,
  reference,
  instructions,
}: MembershipPaymentEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      Pay {amount} to activate your {planName}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Almost there — pay to activate your membership</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, thanks for signing up for <strong>{planName}</strong> at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          . To activate it, pay <strong>{amount}</strong> using the details below.
        </Text>

        <Section style={box}>
          <Text style={rowLabel}>Amount</Text>
          <Text style={rowValue}>{amount}</Text>
          <Hr style={hr} />
          <Text style={rowLabel}>Payment reference (important)</Text>
          <Text style={reference_}>{reference}</Text>
        </Section>

        <Section style={instructionsBox}>
          <ReactMarkdown>{instructions}</ReactMarkdown>
        </Section>

        <Text style={text}>
          <strong>Please include the payment reference in your transfer description.</strong> It's
          how we match your payment to your membership. Once we see it, we'll activate your
          membership and email you a confirmation.
        </Text>
        <Text style={footer}>
          Paying a different way or already transferred? Just reply to this email and we'll sort it
          out.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default MembershipPaymentEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
const link = { color: "inherit", textDecoration: "underline" };
const box = {
  backgroundColor: "#f4f7f8",
  borderRadius: "8px",
  padding: "16px 20px",
  margin: "0 0 20px",
};
const instructionsBox = {
  borderLeft: "3px solid #008eaa",
  padding: "2px 16px",
  margin: "0 0 25px",
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
};
const rowLabel = {
  fontSize: "11px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "#999999",
  margin: "8px 0 0",
};
const rowValue = {
  fontSize: "16px",
  color: "#222222",
  fontWeight: "bold" as const,
  margin: "2px 0 0",
};
const reference_ = {
  fontSize: "20px",
  color: "#008eaa",
  fontWeight: "bold" as const,
  letterSpacing: "0.06em",
  margin: "2px 0 0",
};
const hr = { borderColor: "#e0e6e8", margin: "14px 0" };
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
