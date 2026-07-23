import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

interface InterestNotificationEmailProps {
  siteName: string;
  name: string;
  email: string;
  phone?: string | null;
  experience?: string | null;
  message?: string | null;
  /** Manager dashboard where the funnel of leads/members is reviewed. */
  dashboardUrl: string;
}

/** Sent to managers when someone registers their interest (a new lead). */
export const InterestNotificationEmail = ({
  siteName,
  name,
  email,
  phone,
  experience,
  message,
  dashboardUrl,
}: InterestNotificationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      New free-trial lead: {name || email} for {siteName}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>New free-trial lead</Heading>
        <Text style={text}>
          <strong>{name || "Someone"}</strong> just registered their interest in training at{" "}
          {siteName}.
        </Text>
        <Text style={text}>
          <strong>Name:</strong> {name || "(not given)"}
          <br />
          <strong>Email:</strong>{" "}
          <Link href={`mailto:${email}`} style={link}>
            {email}
          </Link>
          <br />
          <strong>Phone:</strong> {phone || "(not given)"}
          <br />
          <strong>Experience:</strong> {experience || "(not given)"}
          <br />
          <strong>Note:</strong> {message || "(none)"}
        </Text>
        <Text style={text}>
          They&apos;ve been prompted to sign their waiver next. Review the funnel in the manager
          dashboard:
        </Text>
        <Text style={text}>
          <Link href={dashboardUrl} style={link}>
            {dashboardUrl}
          </Link>
        </Text>
        <Text style={footer}>
          You&apos;re receiving this because you&apos;re a manager of {siteName}.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default InterestNotificationEmail;

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
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
