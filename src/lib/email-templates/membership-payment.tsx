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
import type { ClubPaymentDetails } from "@/lib/validation";
import { ClubAccountSection } from "./club-account-section";
import {
  emailHr as hr,
  emailRowLabel as rowLabel,
  emailRowValue as rowValue,
} from "./invoice-styles";

interface MembershipPaymentEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  /**
   * The person the membership is FOR, when that is not the person reading
   * this. See `membership-paid.tsx`: one inbox, possibly several children.
   */
  forName?: string | null;
  planName: string;
  amount: string;
  reference: string;
  /** The club's bank account, or null when it has not published one. */
  details: ClubPaymentDetails | null;
  /** Where a member can read the same details on the site. */
  membershipUrl: string;
}

export const MembershipPaymentEmail = ({
  siteName,
  siteUrl,
  memberName,
  forName,
  planName,
  amount,
  reference,
  details,
  membershipUrl,
}: MembershipPaymentEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      Pay {amount} to activate your {planName}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Almost there. Pay to activate your membership</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, thanks for signing {forName ? `${forName} ` : ""}up for{" "}
          <strong>{planName}</strong> at{" "}
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

        <ClubAccountSection details={details} />

        <Text style={text}>
          <strong>Please include the payment reference in your transfer description.</strong> It's
          how we match your payment to your membership. Once we see it, we'll activate your
          membership and email you a confirmation.
        </Text>
        <Text style={text}>
          You can see these details any time on your{" "}
          <Link href={membershipUrl} style={link}>
            membership page
          </Link>
          , where each one has a copy button.
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
const reference_ = {
  fontSize: "20px",
  color: "#008eaa",
  fontWeight: "bold" as const,
  letterSpacing: "0.06em",
  margin: "2px 0 0",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
