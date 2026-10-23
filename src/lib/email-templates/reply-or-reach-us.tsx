// "Reply to this email", but only when a reply reaches somebody.
//
// Every club email is sent from `noreply@`. A reply reaches a person only once
// a manager has set the club's reply-to address (`email_reply_to`, on
// `/manager/settings`), and the email then carries it as `Reply-To`. Until
// then, an email that says "just reply" invites a member to write into a void,
// often about money ("I already paid", "the amount is wrong"), and they never
// hear back.
//
// So every line that offers a reply is rendered through here, from the same
// `replyTo` value the sender put on the message (`clubReplyTo` in
// `send-email.server.ts`, resolved once before rendering). Set, it prints the
// email's own "reply to this email" sentence. Unset, it points at the contact
// page, the phone and WhatsApp instead, the same three the contact form's own
// auto-reply offers.
import * as React from "react";
import { Link } from "@react-email/components";
import { VENUE_PHONE_DISPLAY, VENUE_PHONE_TEL, WHATSAPP_URL } from "@/lib/venue";

export interface ReplyOrReachUsProps {
  /**
   * Where a reply to this email goes, or null when it reaches nobody. Always the
   * same value the sender put on the message as `Reply-To` (`clubReplyTo`,
   * resolved once before rendering), so the copy and the header agree. Every
   * template with a reply line takes it under this name.
   */
  replyTo: string | null;
  /** The site's origin, for the contact page link. */
  siteUrl: string;
  /** The whole sentence to print when a reply works, e.g. "Just reply to this email." */
  reply: string;
  /**
   * The start of the fallback sentence, before "through our contact page",
   * e.g. "Get in touch" or "If anything looks off, get in touch".
   */
  lead: string;
  /** What follows the ways to reach us, including the full stop. Defaults to ".". */
  tail?: string;
}

const link = { color: "inherit", textDecoration: "underline" };

/**
 * One sentence, as an inline fragment: callers put it inside their own `Text`
 * so it can follow a question like "Paying a different way?" in the same
 * paragraph.
 */
export const ReplyOrReachUs = ({
  replyTo,
  siteUrl,
  reply,
  lead,
  tail = ".",
}: ReplyOrReachUsProps) =>
  replyTo ? (
    <>{reply}</>
  ) : (
    <>
      {lead} through our{" "}
      <Link href={`${siteUrl}/contact`} style={link}>
        contact page
      </Link>
      , call or text{" "}
      <Link href={VENUE_PHONE_TEL} style={link}>
        {VENUE_PHONE_DISPLAY}
      </Link>
      , or message us on{" "}
      <Link href={WHATSAPP_URL} style={link}>
        WhatsApp
      </Link>
      {tail}
    </>
  );
