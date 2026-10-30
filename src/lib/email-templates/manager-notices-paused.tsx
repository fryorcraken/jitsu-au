import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";
import type { ManagerNoticeKind } from "@/lib/rate-limit";
import { PAUSED_NOTICE_COPY } from "./manager-notices-paused-copy";

interface ManagerNoticesPausedEmailProps {
  siteName: string;
  kind: ManagerNoticeKind;
  /** How many a day it takes to pause them. */
  cap: number;
  /** The manager screen that lists every one of them. */
  screenUrl: string;
}

/**
 * Sent to managers ONCE when a kind of per-submission email (new lead, new
 * message, new waiver) goes over its daily cap, in place of the email that
 * would have tipped it over. After this, nothing more of that kind until the
 * day's count drops back under the cap. See `claimManagerNotice`.
 */
export const ManagerNoticesPausedEmail = ({
  siteName,
  kind,
  cap,
  screenUrl,
}: ManagerNoticesPausedEmailProps) => {
  const copy = PAUSED_NOTICE_COPY[kind];
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{copy.subject}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{copy.heading}</Heading>
          <Text style={text}>
            More than {cap} {copy.happened} in the last 24 hours, which is far more than usual. It
            could be a busy day, like an open day or O-Week, or it could be a bot, which the site is
            already limiting. Either way, rather than fill your inbox, we have stopped sending an
            email for each one.
          </Text>
          <Text style={text}>
            Nothing is lost. Every one is saved and listed on the {copy.where}:
          </Text>
          <Text style={text}>
            <Link href={screenUrl} style={link}>
              {screenUrl}
            </Link>
          </Text>
          <Text style={text}>{copy.advice}</Text>
          <Text style={text}>
            The emails start again by themselves once things quieten down. If it gets this busy
            again within a day of this email, we won&apos;t send another one, so check the page
            above until then.
          </Text>
          <Text style={footer}>
            You&apos;re receiving this because you&apos;re a manager of {siteName}.
          </Text>
        </Container>
      </Body>
    </Html>
  );
};

export default ManagerNoticesPausedEmail;

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
