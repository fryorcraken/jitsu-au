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

interface AccountActivatedEmailProps {
  siteName: string;
  siteUrl: string;
  /** What to call them to their face: preferred name, else first name. */
  memberName: string;
  /**
   * The address their account is keyed on, shown so they know what to type on
   * the sign-in page. It is the only identifier they have: there is no username
   * and, on first activation, no password either.
   */
  loginEmail: string;
  /** The sign-in page. Deliberately the only call to action in this email. */
  signInUrl: string;
  kbUrl: string;
  codeOfConductUrl: string;
  membershipUrl: string;
  blogUrl: string;
}

/**
 * Sent once a manager approves someone's first waiver and their login is
 * unlocked.
 *
 * This email carries NO sign-in link, on purpose. It used to send a magic link
 * nobody had asked for, which reads as odd on arrival and is worse an hour
 * later when it has quietly expired. Instead it says the account is open,
 * names the address to sign in with, and points at the sign-in page, where
 * they request a link themselves (or set a password). One extra step, and it
 * still works whenever they get round to reading it.
 */
export const AccountActivatedEmail = ({
  siteName,
  siteUrl,
  memberName,
  loginEmail,
  signInUrl,
  kbUrl,
  codeOfConductUrl,
  membershipUrl,
  blogUrl,
}: AccountActivatedEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your {siteName} account is active</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your account is active</Heading>
        <Text style={text}>
          Hi {memberName || "there"}, your waiver has been approved and your account at{" "}
          <Link href={siteUrl} style={link}>
            <strong>{siteName}</strong>
          </Link>{" "}
          is now open. You&apos;re cleared to train.
        </Text>
        <Text style={text}>
          Your login is <strong>{loginEmail}</strong>
        </Text>
        <Button style={button} href={signInUrl}>
          Sign in
        </Button>
        <Text style={text}>
          Enter that address on the sign-in page and we&apos;ll email you a link to get in. You can
          set a password once you&apos;re there, if you&apos;d rather sign in that way.
        </Text>
        <Text style={h2}>What&apos;s waiting for you</Text>
        <Text style={item}>
          <Link href={kbUrl} style={itemLink}>
            The knowledge base
          </Link>
          . What happens in your first session, how our belts and grading work, and how the club
          runs. Worth a read before you turn up.
        </Text>
        <Text style={item}>
          <Link href={codeOfConductUrl} style={itemLink}>
            The code of conduct
          </Link>
          . How we train together: hygiene, mat etiquette, gear, and keeping each other safe. Please
          read it and agree when you have a minute.
        </Text>
        <Text style={item}>
          <Link href={membershipUrl} style={itemLink}>
            Your membership
          </Link>
          . What you&apos;re on, what&apos;s been paid, and any invoices waiting on you.
        </Text>
        <Text style={item}>
          <Link href={blogUrl} style={itemLink}>
            The blog
          </Link>
          . Club news and write-ups, and you can join the conversation in the comments once
          you&apos;re signed in.
        </Text>
        <Text style={footer}>
          See you on the mat. Reply to this email if anything looks off, or if you can&apos;t get
          in.
        </Text>
      </Container>
    </Body>
  </Html>
);

export default AccountActivatedEmail;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "20px 25px" };
const h1 = {
  fontSize: "22px",
  fontWeight: "bold" as const,
  color: "#008eaa",
  margin: "0 0 20px",
};
const h2 = {
  fontSize: "16px",
  fontWeight: "bold" as const,
  color: "#55575d",
  margin: "30px 0 15px",
};
const text = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 25px",
};
const item = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 15px",
};
const link = { color: "inherit", textDecoration: "underline" };
const itemLink = { color: "#008eaa", textDecoration: "underline", fontWeight: "bold" as const };
const button = {
  backgroundColor: "#008eaa",
  color: "#ffffff",
  fontSize: "14px",
  borderRadius: "8px",
  padding: "12px 20px",
  textDecoration: "none",
};
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
