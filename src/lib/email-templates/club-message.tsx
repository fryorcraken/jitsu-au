import * as React from "react";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";
import ReactMarkdown, { type Components } from "react-markdown";

import { ReplyOrReachUs } from "./reply-or-reach-us";

interface ClubMessageEmailProps {
  siteName: string;
  siteUrl: string;
  /** What to call the person reading it. Blank falls back to "there". */
  greeting: string;
  subject: string;
  /** The manager's own words, in markdown. */
  body: string;
  /**
   * Who in this inbox it is about, when that is somebody other than the
   * reader: "Bea", or "you, Bea and Sam". Null when it is only the reader.
   */
  forWhom?: string | null;
  /** Who it is going to, which decides the line at the bottom. */
  audience: "person" | "lead";
  /** See `ReplyOrReachUsProps["replyTo"]` in `reply-or-reach-us.tsx`. */
  replyTo: string | null;
  /** A manager's test copy says so at the top, so nobody forwards it as the real thing. */
  test?: boolean;
}

/**
 * A club notice: one message a manager wrote to members, applicants or leads.
 *
 * The body is the manager's markdown, rendered with inline styles, because an
 * email client ignores the Tailwind classes the site's own markdown renderers
 * use. Raw HTML in the markdown is never rendered (react-markdown escapes it by
 * default), and images are shown as their alt text: a manager typing a picture
 * link into a notice should not make every member's mail client fetch it.
 */
export const ClubMessageEmail = ({
  siteName,
  siteUrl,
  greeting,
  subject,
  body,
  forWhom,
  audience,
  replyTo,
  test,
}: ClubMessageEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{subject}</Preview>
    <Body style={main}>
      <Container style={container}>
        {test && (
          <Text style={testBanner}>
            Test copy, sent only to you. This is how it will look to everyone else.
          </Text>
        )}
        <Heading style={h1}>{subject}</Heading>
        <Text style={text}>
          Hi {greeting || "there"},{forWhom ? ` this is about ${forWhom}.` : ""}
        </Text>
        <ReactMarkdown components={markdownComponents}>{body}</ReactMarkdown>
        <Text style={footer}>
          Questions?{" "}
          <ReplyOrReachUs
            replyTo={replyTo}
            siteUrl={siteUrl}
            reply="Just reply to this email."
            lead="Get in touch"
          />{" "}
          {audience === "lead"
            ? `You're getting this because you asked about training at ${siteName}.`
            : `This is a club notice from ${siteName} about training.`}
        </Text>
      </Container>
    </Body>
  </Html>
);

export default ClubMessageEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = { fontSize: "22px", fontWeight: "bold" as const, color: "#008eaa", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 16px" };
const link = { color: "#008eaa", textDecoration: "underline" };
const list = { ...text, paddingLeft: "22px" };
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
const testBanner = {
  fontSize: "13px",
  color: "#7a4b00",
  backgroundColor: "#fff4d6",
  padding: "10px 12px",
  borderRadius: "6px",
  margin: "0 0 20px",
};

/** Every element the manager's markdown can produce, styled for a mail client. */
const markdownComponents: Components = {
  p: ({ children }) => <Text style={text}>{children}</Text>,
  a: ({ href, children }) => (
    <Link href={href} style={link}>
      {children}
    </Link>
  ),
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  ul: ({ children }) => <ul style={list}>{children}</ul>,
  ol: ({ children }) => <ol style={list}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: "0 0 6px" }}>{children}</li>,
  h1: ({ children }) => <Text style={{ ...text, fontWeight: "bold" }}>{children}</Text>,
  h2: ({ children }) => <Text style={{ ...text, fontWeight: "bold" }}>{children}</Text>,
  h3: ({ children }) => <Text style={{ ...text, fontWeight: "bold" }}>{children}</Text>,
  h4: ({ children }) => <Text style={{ ...text, fontWeight: "bold" }}>{children}</Text>,
  blockquote: ({ children }) => (
    <div style={{ borderLeft: "3px solid #dddddd", paddingLeft: "12px", margin: "0 0 16px" }}>
      {children}
    </div>
  ),
  img: ({ alt }) => <>{alt ?? ""}</>,
  hr: () => <hr style={{ border: "none", borderTop: "1px solid #eeeeee", margin: "20px 0" }} />,
  code: ({ children }) => <code>{children}</code>,
};
