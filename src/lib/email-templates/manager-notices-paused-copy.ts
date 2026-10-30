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
    advice: "Have a look when you get a chance: on a busy day they are all real people.",
  },
  message: {
    subject: "Lots of contact messages today, so we've paused those emails",
    heading: "We've paused the email for each new message",
    happened: "contact messages have come in",
    where: "contact inbox",
    advice: "Have a look when you get a chance: some may be real questions waiting for an answer.",
  },
  waiver: {
    subject: "Lots of waivers signed today, so we've paused those emails",
    heading: "We've paused the email for each new waiver",
    happened: "waivers have been signed",
    where: "Waivers page",
    advice:
      "Look through them before approving. Approving a waiver opens an account and emails the person, so leave any that look made up (nonsense names, throwaway addresses) for now.",
  },
};
