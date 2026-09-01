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
  /**
   * The child this account was opened for, when it was opened by approving
   * their waiver rather than the reader's own.
   *
   * Null for everyone signing for themselves, which is the common case and
   * reads exactly as it always has. Set, it changes who the email is about: a
   * parent who may never train themselves needs to know at a glance that this
   * account is how they look after their child's training, or "your waiver has
   * been approved" is a sentence about a form they did not fill in for
   * themselves.
   */
  dependantName?: string | null;
  /** The sign-in page. Deliberately the only call to action in this email. */
  signInUrl: string;
  kbUrl: string;
  codeOfConductUrl: string;
  membershipUrl: string;
  blogUrl: string;
  /**
   * The contact form, offered instead of "reply to this email".
   *
   * Everything here is sent from `noreply@`, with no reply-to header, so a
   * reply goes nowhere. That is a small thing to get wrong in most emails and
   * a large one here: this is the email a person reads when they cannot get
   * in, and the reply we invited would be their attempt to say so.
   */
  contactUrl: string;
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
  dependantName,
  signInUrl,
  kbUrl,
  codeOfConductUrl,
  membershipUrl,
  blogUrl,
  contactUrl,
}: AccountActivatedEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your {siteName} account is active</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your account is active</Heading>
        {dependantName ? (
          <Text style={text}>
            Hi {memberName || "there"}, {dependantName}&apos;s waiver has been approved and your
            account at{" "}
            <Link href={siteUrl} style={link}>
              <strong>{siteName}</strong>
            </Link>{" "}
            is now open. {dependantName} is cleared to train, and you look after everything from
            your account.
          </Text>
        ) : (
          <Text style={text}>
            Hi {memberName || "there"}, your waiver has been approved and your account at{" "}
            <Link href={siteUrl} style={link}>
              <strong>{siteName}</strong>
            </Link>{" "}
            is now open. You&apos;re cleared to train.
          </Text>
        )}
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
          <Link href={codeOfConductUrl} style={itemLink}>
            The code of conduct
          </Link>
          .{" "}
          {dependantName
            ? `How we train together: hygiene, mat etiquette, gear, and keeping each other safe. Please read it and agree on ${dependantName}'s behalf when you have a minute.`
            : "How we train together: hygiene, mat etiquette, gear, and keeping each other safe. Please read it and agree when you have a minute."}
        </Text>
        <Text style={item}>
          <Link href={membershipUrl} style={itemLink}>
            {dependantName ? "Memberships" : "Your membership"}
          </Link>
          .{" "}
          {dependantName
            ? "What each person on your account is on, what has been paid, and any invoices waiting on you."
            : "What you're on, what's been paid, and any invoices waiting on you."}
        </Text>
        <Text style={item}>
          <Link href={blogUrl} style={itemLink}>
            The blog
          </Link>
          . Club news and write-ups, and you can join the conversation in the comments once
          you&apos;re signed in.
        </Text>
        {/* The knowledge base gets a passing mention rather than a slot of its
            own. It is the biggest thing in the member area and the easiest to
            over-sell here: a new member has two jobs in this email, agreeing to
            the code of conduct and knowing where their membership lives, and a
            fourth heading competing with those buries both. */}
        <Text style={item}>
          There&apos;s also our{" "}
          <Link href={kbUrl} style={itemLink}>
            knowledge base
          </Link>{" "}
          when you want it: what happens in your first session, how our belts and grading work, and
          how the club runs.
        </Text>
        <Text style={footer}>
          See you on the mat. If anything looks off, or you can&apos;t get in,{" "}
          <Link href={contactUrl} style={link}>
            get in touch
          </Link>{" "}
          and we&apos;ll sort it out.
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
