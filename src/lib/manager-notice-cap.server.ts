// The daily cap on the per-submission emails managers get (#52): a new lead, a
// new contact message, a newly signed waiver.
//
// One email per submission per manager is right on a normal day, when there
// are a handful a week and a manager answers a question by pressing Reply. It
// is wrong in a flood, where it turns every bot submission into another email
// from the club's sending domain. So the first `EMAIL_CAPS.managerPerKind` of
// each kind in a rolling day go out as usual, the next one is replaced by a
// single note saying the emails have paused and where the rest are, and after
// that nothing of that kind until the count drops back under the cap.
//
// Nothing is lost by pausing: every submission is still saved, listed on its
// manager screen, and counted on the notifications page's "needs attention"
// list, which is where a manager finds them anyway.
//
// Server only. Imported by the three email modules that send these, which are
// themselves only ever lazy-imported from server-function handlers.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendEmail } from "@/lib/send-email.server";
import { ManagerNoticesPausedEmail } from "@/lib/email-templates/manager-notices-paused";
import { PAUSED_NOTICE_COPY } from "@/lib/email-templates/manager-notices-paused-copy";
import { EMAIL_CAPS, type ManagerNoticeKind } from "@/lib/rate-limit";
import { claimManagerNotice } from "@/lib/rate-limit.server";
import { SITE_NAME } from "@/lib/email-sender";

type AdminClient = SupabaseClient<Database>;

/**
 * Whether to send the managers their usual copy of this submission.
 *
 * True: go ahead. False: do not, because the day's cap is reached; when this
 * is the submission that reached it, the managers have just been sent the
 * "paused" note in its place. Never throws: a failed note is logged, and the
 * answer is still false, since the cap was what was asked about.
 */
export async function mayNotifyManagers(
  admin: AdminClient,
  opts: {
    kind: ManagerNoticeKind;
    /** One per submission: the same key a retry carries. */
    submissionKey: string;
    recipients: string[];
    /** The manager screen that lists every submission of this kind. */
    screenUrl: string;
    apiKey: string;
    sendUrl?: string;
  },
): Promise<boolean> {
  if (opts.recipients.length === 0) return false;
  const decision = await claimManagerNotice(admin, opts.kind, opts.submissionKey);
  if (decision === "send") return true;
  if (decision === "paused") {
    console.warn(`[manager-notice-cap] ${opts.kind} emails are paused for today; skipped one`);
    return false;
  }

  const el = React.createElement(ManagerNoticesPausedEmail, {
    siteName: SITE_NAME,
    kind: opts.kind,
    cap: EMAIL_CAPS.managerPerKind,
    screenUrl: opts.screenUrl,
  });
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  for (const to of opts.recipients) {
    try {
      await sendEmail({
        apiKey: opts.apiKey,
        sendUrl: opts.sendUrl,
        to,
        subject: PAUSED_NOTICE_COPY[opts.kind].subject,
        html,
        text,
        idempotencyKey: `manager-paused-${opts.kind}-${opts.submissionKey}-${to}`,
        // About no one in particular, and nothing in it asks for a reply.
        replyTo: null,
      });
    } catch (e) {
      console.error(`[manager-notice-cap] failed to send the paused note to a manager:`, e);
    }
  }
  return false;
}
