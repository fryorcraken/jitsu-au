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

interface CommentReplyEmailProps {
  siteName: string;
  /** The replier's public display name, never their legal name (see docs/blog.md). */
  authorName: string;
  /** What they wrote, already trimmed to a preview by `commentPreview`. */
  preview: string;
  /** Absolute link to the comment, anchored so it opens on the reply. */
  replyUrl: string;
  /** Where this person can change what gets emailed. Works signed out. */
  settingsUrl: string;
  /** "your comment on Belt gradings" reads better than a bare "your comment". */
  context: string;
}

/** Sent the moment somebody replies to your blog or knowledge base comment. */
export const CommentReplyEmail = ({
  siteName,
  authorName,
  preview,
  replyUrl,
  settingsUrl,
  context,
}: CommentReplyEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {authorName} replied to {context}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{authorName} replied to you</Heading>
        <Text style={text}>
          On {context} at {siteName}, {authorName} wrote:
        </Text>
        <Text style={quote}>{preview}</Text>
        <Button style={button} href={replyUrl}>
          Read the reply
        </Button>
        <Text style={footer}>
          You are getting this because somebody replied to you.{" "}
          <Link href={settingsUrl} style={link}>
            Choose what we email you
          </Link>
          .
        </Text>
      </Container>
    </Body>
  </Html>
);

export default CommentReplyEmail;

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
const quote = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 25px",
  padding: "10px 15px",
  borderLeft: "3px solid #008eaa",
  backgroundColor: "#f6f8f9",
};
const link = { color: "inherit", textDecoration: "underline" };
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
