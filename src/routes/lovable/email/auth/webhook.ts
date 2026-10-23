import * as React from "react";
import { createAuthEmailHandler } from "@lovable.dev/email-js";
import { createFileRoute } from "@tanstack/react-router";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";
import { SITE_ORIGIN } from "@/lib/seo";
// The sender and the name come from `email-sender.ts`, shared with every other
// email the app sends (docs/emails.md).
import { FROM, SENDER_DOMAIN, SITE_NAME } from "@/lib/email-sender";

// The SDK handler owns verification, dispatch, and retry semantics; this file
// owns only the email decisions: subjects, templates, and per-type props.
// Built lazily: process.env is only populated at request time, so creating the
// handler at module scope throws "Missing Lovable API key" during route load.
let cachedHandler: ReturnType<typeof createAuthEmailHandler> | undefined;

function getHandler() {
  if (cachedHandler) return cachedHandler;
  cachedHandler = createAuthEmailHandler({
    apiKey: process.env.LOVABLE_API_KEY!,
    from: FROM,
    senderDomain: SENDER_DOMAIN,
    sendUrl: process.env.LOVABLE_SEND_URL,
    emails: {
      signup: {
        subject: "Confirm your email",
        render: (data) =>
          React.createElement(SignupEmail, {
            siteName: SITE_NAME,
            siteUrl: SITE_ORIGIN,
            recipient: data.email,
            confirmationUrl: data.url,
          }),
      },
      invite: {
        subject: "You've been invited",
        render: (data) =>
          React.createElement(InviteEmail, {
            siteName: SITE_NAME,
            siteUrl: SITE_ORIGIN,
            confirmationUrl: data.url,
          }),
      },
      magiclink: {
        subject: "Your login link",
        render: (data) =>
          React.createElement(MagicLinkEmail, {
            siteName: SITE_NAME,
            confirmationUrl: data.url,
          }),
      },
      recovery: {
        subject: "Reset your password",
        render: (data) =>
          React.createElement(RecoveryEmail, {
            siteName: SITE_NAME,
            confirmationUrl: data.url,
          }),
      },
      email_change: {
        subject: "Confirm your new email",
        render: (data) =>
          React.createElement(EmailChangeEmail, {
            siteName: SITE_NAME,
            oldEmail: data.old_email ?? "",
            email: data.email,
            newEmail: data.new_email ?? "",
            confirmationUrl: data.url,
          }),
      },
      reauthentication: {
        subject: "Your verification code",
        render: (data) => React.createElement(ReauthenticationEmail, { token: data.token ?? "" }),
      },
    },
  });
  return cachedHandler;
}

export const Route = createFileRoute("/lovable/email/auth/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => getHandler()(request),
    },
  },
});
