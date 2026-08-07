import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

export interface DigestLine {
  title: string;
  body: string | null;
  /** Absolute link to the thing that happened. */
  url: string;
}

export interface DigestBlock {
  heading: string;
  lines: DigestLine[];
}

interface NotificationDigestEmailProps {
  siteName: string;
  greeting: string;
  /** Only non-empty blocks are passed in, so the email never shows a bare heading. */
  blocks: DigestBlock[];
  notificationsUrl: string;
  settingsUrl: string;
}

/** The once-a-day summary of everything that was not worth an instant email. */
export const NotificationDigestEmail = ({
  siteName,
  greeting,
  blocks,
  notificationsUrl,
  settingsUrl,
}: NotificationDigestEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>What happened at {siteName} since yesterday</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Since yesterday</Heading>
        <Text style={text}>
          {greeting}, here is what happened at {siteName}.
        </Text>

        {blocks.map((block) => (
          <div key={block.heading}>
            <Heading as="h2" style={h2}>
              {block.heading}
            </Heading>
            {block.lines.map((line) => (
              <Text key={line.url + line.title} style={item}>
                <Link href={line.url} style={itemLink}>
                  {line.title}
                </Link>
                {line.body ? <span style={itemBody}>{line.body}</span> : null}
              </Text>
            ))}
          </div>
        ))}

        <Text style={text}>
          <Link href={notificationsUrl} style={link}>
            Open your notifications
          </Link>
        </Text>
        <Text style={footer}>
          You are getting this because you take part at {siteName}.{" "}
          <Link href={settingsUrl} style={link}>
            Choose what we email you
          </Link>
          .
        </Text>
      </Container>
    </Body>
  </Html>
);

export default NotificationDigestEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = {
  fontSize: "22px",
  fontWeight: "bold" as const,
  color: "#008eaa",
  margin: "0 0 20px",
};
const h2 = {
  fontSize: "15px",
  fontWeight: "bold" as const,
  color: "#2b2d31",
  margin: "25px 0 10px",
};
const text = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 20px",
};
const item = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 10px",
};
const itemLink = { color: "#008eaa", textDecoration: "none", fontWeight: "bold" as const };
const itemBody = { display: "block", color: "#77797d" };
const link = { color: "inherit", textDecoration: "underline" };
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
