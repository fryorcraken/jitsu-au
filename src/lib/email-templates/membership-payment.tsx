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
import {
  CLUB_ACCOUNT_FIELDS,
  CLUB_INTERNATIONAL_FIELDS,
  clubPaymentFieldValue,
  hasInternationalDetails,
} from "@/lib/validation";
import type { ClubPaymentDetails } from "@/lib/validation";

interface MembershipPaymentEmailProps {
  siteName: string;
  siteUrl: string;
  memberName: string;
  planName: string;
  amount: string;
  reference: string;
  /** The club's bank account, or null when it has not published one. */
  details: ClubPaymentDetails | null;
  /** Where a member can read the same details on the site. */
  membershipUrl: string;
}

/**
 * The club's account, as labelled rows. Same fields, same order and same source
 * as the "how to pay" panel on `/membership`, walked from the same list so the
 * email and the page cannot come to quote different bank details.
 *
 * No copy buttons here: this is an email, and every client renders it
 * differently. The page is where copying works, which is why the email links to
 * it.
 */
const AccountRows = ({ details }: { details: ClubPaymentDetails }) => (
  <>
    {CLUB_ACCOUNT_FIELDS.map((field) => {
      const value = clubPaymentFieldValue(details, field.key);
      if (!value) return null;
      return (
        <React.Fragment key={field.key}>
          <Text style={rowLabel}>{field.label}</Text>
          <Text style={field.mono ? rowValueMono : rowValue}>{value}</Text>
        </React.Fragment>
      );
    })}
  </>
);

export const MembershipPaymentEmail = ({
  siteName,
  siteUrl,
  memberName,
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

        {details ? (
          <Section style={instructionsBox}>
            <AccountRows details={details} />
            {hasInternationalDetails(details) && (
              <>
                <Hr style={hr} />
                <Text style={sectionHeading}>Paying from overseas</Text>
                {CLUB_INTERNATIONAL_FIELDS.map((field) => {
                  const value = clubPaymentFieldValue(details, field.key);
                  if (!value) return null;
                  return (
                    <React.Fragment key={field.key}>
                      <Text style={rowLabel}>{field.label}</Text>
                      <Text style={field.mono ? rowValueMono : rowValue}>{value}</Text>
                    </React.Fragment>
                  );
                })}
                <Text style={smallNote}>
                  Banks along the way can take fees out of an international transfer, so ask yours
                  to send the full amount. If it arrives short we will still sort it out, it just
                  takes us a little longer.
                </Text>
              </>
            )}
            {details.note && (
              <>
                <Hr style={hr} />
                <ReactMarkdown>{details.note}</ReactMarkdown>
              </>
            )}
          </Section>
        ) : (
          <Section style={instructionsBox}>
            <Text style={text}>
              We have not published our account details yet. Reply to this email and we'll send them
              straight over.
            </Text>
          </Section>
        )}

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
// Digit strings people transcribe into a banking app. Monospace so a misread
// character is visible, and letter-spaced for the same reason.
const rowValueMono = {
  ...rowValue,
  fontFamily: "'Courier New', Courier, monospace",
  letterSpacing: "0.04em",
};
const sectionHeading = {
  fontSize: "13px",
  color: "#222222",
  fontWeight: "bold" as const,
  margin: "0 0 4px",
};
const smallNote = { fontSize: "12px", color: "#777777", margin: "12px 0 0", lineHeight: "1.5" };
const reference_ = {
  fontSize: "20px",
  color: "#008eaa",
  fontWeight: "bold" as const,
  letterSpacing: "0.06em",
  margin: "2px 0 0",
};
const hr = { borderColor: "#e0e6e8", margin: "14px 0" };
const footer = { fontSize: "12px", color: "#999999", margin: "30px 0 0" };
