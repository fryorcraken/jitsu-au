// The words of the managers' "we've paused these emails" note, apart from the
// template so the sender (which needs the subject) and the template share one
// copy, and so the component file exports only a component.
import type { ManagerNoticeKind } from "@/lib/rate-limit";

/**
 * What each kind of per-submission email is about, in the managers' words.
 * `subject` is exported so the sender and the template cannot disagree.
 */
export const PAUSED_NOTICE_COPY: Record<
  ManagerNoticeKind,
  { subject: string; heading: string; happened: string; where: string; advice: string }
> = {
  lead: {
    subject: "Lots of new sign-ups today, so we've paused those emails",
    heading: "We've paused the email for each new sign-up",
    happened: "people have registered interest",
    where: "Users page",
    advice: "Real people are in there too, so have a look when you get a chance.",
  },
  message: {
    subject: "Lots of contact messages today, so we've paused those emails",
    heading: "We've paused the email for each new message",
    happened: "contact messages have come in",
    where: "contact inbox",
    advice: "Some may be real questions, so have a look when you get a chance.",
  },
  waiver: {
    subject: "Lots of waivers signed today, so we've paused those emails",
    heading: "We've paused the email for each new waiver",
    happened: "waivers have been signed",
    where: "Waivers page",
    advice:
      "Don't approve anyone you don't recognise. Approving a waiver opens an account and emails the person.",
  },
};
