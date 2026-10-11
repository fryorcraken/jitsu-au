// The club's bank account, as it appears in every email that asks for money.
//
// Shared by the membership invoice and the item invoice so the two cannot come
// to quote different bank details. Same fields, same order and same source as
// the "How to pay" panel on `/membership` (`ClubAccountDetails`), walked from
// the same lists in `validation.ts`.
//
// No copy buttons here: this is an email, and every client renders it
// differently. The page is where copying works, which is why both emails link
// to it.
import * as React from "react";
import { Hr, Section, Text } from "@react-email/components";
import ReactMarkdown from "react-markdown";
import {
  CLUB_ACCOUNT_FIELDS,
  CLUB_INTERNATIONAL_FIELDS,
  clubPaymentFieldValue,
  hasInternationalDetails,
} from "@/lib/validation";
import type { ClubPaymentDetails } from "@/lib/validation";
import { emailHr, emailRowLabel, emailRowValue } from "./invoice-styles";

/** One labelled value, in the style both invoice emails use for every figure. */
const Row = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
  <>
    <Text style={emailRowLabel}>{label}</Text>
    <Text style={mono ? rowValueMono : emailRowValue}>{value}</Text>
  </>
);

/**
 * The account block, or a plain sentence when the club has not published one.
 * `details` null covers both "never published" and "could not read": either way
 * the email cannot name an account, and it says so rather than inventing one.
 */
export const ClubAccountSection = ({ details }: { details: ClubPaymentDetails | null }) =>
  details ? (
    <Section style={instructionsBox}>
      {CLUB_ACCOUNT_FIELDS.map((field) => {
        const value = clubPaymentFieldValue(details, field.key);
        if (!value) return null;
        return <Row key={field.key} label={field.label} value={value} mono={field.mono} />;
      })}
      {hasInternationalDetails(details) && (
        <>
          <Hr style={emailHr} />
          <Text style={sectionHeading}>Paying from overseas</Text>
          {CLUB_INTERNATIONAL_FIELDS.map((field) => {
            const value = clubPaymentFieldValue(details, field.key);
            if (!value) return null;
            return <Row key={field.key} label={field.label} value={value} mono={field.mono} />;
          })}
          <Text style={smallNote}>
            Banks along the way can take fees out of an international transfer, so ask yours to send
            the full amount. If it arrives short we will still sort it out, it just takes us a
            little longer.
          </Text>
        </>
      )}
      {details.note && (
        <>
          <Hr style={emailHr} />
          <ReactMarkdown>{details.note}</ReactMarkdown>
        </>
      )}
    </Section>
  ) : (
    <Section style={instructionsBox}>
      <Text style={plainText}>
        We have not published our account details yet. Reply to this email and we'll send them
        straight over.
      </Text>
    </Section>
  );

const instructionsBox = {
  borderLeft: "3px solid #008eaa",
  padding: "2px 16px",
  margin: "0 0 25px",
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
};
// Digit strings people transcribe into a banking app. Monospace so a misread
// character is visible, and letter-spaced for the same reason.
const rowValueMono = {
  ...emailRowValue,
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
const plainText = { fontSize: "14px", color: "#55575d", lineHeight: "1.5", margin: "0 0 25px" };
