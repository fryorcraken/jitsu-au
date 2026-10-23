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

import { emailRowLabel, emailRowValue } from "./invoice-styles";

interface MembershipPlanOpenEmailProps {
  siteName: string;
  siteUrl: string;
  /** What to call the person reading it. Blank falls back to "there". */
  greeting: string;
  planName: string;
  /** The manager's own description of the plan, when it has one. */
  description?: string | null;
  /** When it runs, e.g. "2 Mar 2027 to 30 Jun 2027". Null leaves the row out. */
  runs?: string | null;
  /** Both rates where there is a student price, already formatted. */
  price: string;
  /**
   * Who in this inbox it is for, when that is more than the reader: "you, Bea
   * and Sam", or just "Bea" for a parent who does not train. Null when it is
   * only the reader, which needs no saying.
   */
  forWhom?: string | null;
  /**
   * Who here will also need yearly insurance to train on it, and what that
   * costs. Null when nobody does.
   */
  insurance?: { who: string; price: string } | null;
  /** Absolute link to the plan on the signed-in membership page. */
  buyUrl: string;
}

/**
 * Sent when a manager announces a membership plan to every member.
 *
 * A membership email, like an invoice, so it carries no "turn this off" link:
 * no switch governs it (`docs/notifications.md`). It says so at the bottom, so a
 * member who has turned announcements off is not left wondering why this one
 * still came.
 */
export const MembershipPlanOpenEmail = ({
  siteName,
  siteUrl,
  greeting,
  planName,
  description,
  runs,
  price,
  forWhom,
  insurance,
  buyUrl,
}: MembershipPlanOpenEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {planName}: {price}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{planName}</Heading>
        <Text style={text}>
          Hi {greeting || "there"}, here are the details of {planName} at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>
          {forWhom ? `, for ${forWhom}` : ""}.{description ? ` ${description}` : ""}
        </Text>
        {runs && (
          <>
            <Text style={emailRowLabel}>Runs</Text>
            <Text style={emailRowValue}>{runs}</Text>
          </>
        )}
        <Text style={emailRowLabel}>Price</Text>
        <Text style={emailRowValue}>{price}</Text>
        {insurance && (
          <Text style={{ ...text, margin: "20px 0 0" }}>
            To train, {insurance.who} will also need yearly insurance ({insurance.price}). You can
            add it when you buy the plan.
          </Text>
        )}
        <Button style={button} href={buyUrl}>
          Buy {planName}
        </Button>
        <Text style={footer}>
          This is about your membership, like an invoice, so it is not one of the emails you can
          turn off.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default MembershipPlanOpenEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
const link = { color: "inherit", textDecoration: "underline" };
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
  margin: "25px 0 0",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
