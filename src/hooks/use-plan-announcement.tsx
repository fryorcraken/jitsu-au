// "Email all members about this plan": the tick box beside a plan's Save
// button, the hard stop before anything goes, and the panel that reports the
// send.
//
// Saving and announcing are two steps on purpose (`announcePlan` in
// `membership.functions.ts` has the server half). The plan is saved first by
// the screen's own save, then announced here, so the screen can say "saved, but
// the email did not go" and offer a retry that announces again WITHOUT saving
// again. That matters most for a new plan: a retried create would be a second
// copy of the plan.
//
// The retry is safe because one announcement keeps one id, and the server uses
// that id as the announcement's own: the same id again writes no new rows and
// emails only whoever is still owed. Every fresh send mints a new id, so the
// next tick is a genuinely new announcement, which is how a plan is announced a
// second time on purpose.
import { useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { useConfirm } from "@/hooks/use-confirm";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { describeLoadError } from "@/lib/load-error";
import { announcePlan, countPlanAnnouncementAudience } from "@/lib/membership.functions";
import { announceConfirmTitle } from "@/lib/plan-announcement";
import { ANNOUNCE_SUBMIT, newSubmissionId } from "@/lib/submit-resilience";

export type AnnounceResult = Awaited<ReturnType<typeof announcePlan>>;

export function usePlanAnnouncement(onAnnounced: (result: AnnounceResult) => void): {
  ticked: boolean;
  setTicked: (ticked: boolean) => void;
  /** True while an announcement is in flight, for disabling Save. */
  busy: boolean;
  /**
   * Ask before a save that will announce, with the real number of emails.
   * Answers true straight away when the box is not ticked. False means do not
   * save: either the manager said no, or the count could not be read, in which
   * case `panel` says so.
   */
  confirmBeforeSave: (planName: string, opts?: { saving: boolean }) => Promise<boolean>;
  /** Announce a plan that has just been saved. */
  send: (plan: { id: string; name: string }) => Promise<void>;
  /** Everything this puts on screen: progress, failure, partial send, the dialog. */
  panel: ReactNode;
} {
  const [ticked, setTicked] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [partial, setPartial] = useState<AnnounceResult | null>(null);
  const announcementId = useRef(newSubmissionId());
  const count = useServerFn(countPlanAnnouncementAudience);
  const announce = useServerFn(announcePlan);
  const submit = useResilientSubmit<AnnounceResult>(ANNOUNCE_SUBMIT);
  const { confirm, confirmDialog } = useConfirm();

  async function confirmBeforeSave(
    planName: string,
    opts: { saving: boolean } = { saving: true },
  ): Promise<boolean> {
    // Cleared first, so a count that failed on an earlier Save never sits next
    // to a save that has since worked.
    setCountError(null);
    if (!ticked) return true;
    let inboxes: number;
    try {
      inboxes = (await count()).inboxes;
    } catch (e) {
      setCountError(describeLoadError(e, "We could not work out who to email"));
      return false;
    }
    return confirm({
      title: announceConfirmTitle(planName, inboxes, opts),
      description: `${
        opts.saving ? "This saves the plan, then emails" : "This emails"
      } everyone whose waiver has been approved. A family gets one email, sent to the parent and naming the children.`,
      details: [
        "The email has the plan's dates and price, and a link to buy it.",
        "Nobody can turn this email off, because it is about their membership.",
      ],
      footnote: "This can't be undone.",
      confirmLabel: opts.saving ? "Save and email" : "Email members",
    });
  }

  /** A new announcement: a fresh id, whatever the last one left behind. */
  async function send(plan: { id: string; name: string }) {
    // The box has done its job once the plan is saved. Anything from here is a
    // retry of THIS announcement, which the panel offers; leaving the box
    // ticked would make the next Save look like a fresh announcement.
    setTicked(false);
    // Minted here rather than taken from `useResilientSubmit`, whose id only
    // changes on a re-render after `reset()`. An announcement that failed or
    // left emails pending never resets, so a later one from the same form (the
    // next new plan, or this plan again on purpose) would otherwise go out
    // under the old id: refused as another plan's, or absorbed as a repeat.
    announcementId.current = newSubmissionId();
    await deliver(plan);
  }

  /** The same announcement again: the retry, and "Send the rest now". */
  async function deliver(plan: { id: string; name: string }) {
    setTarget(plan);
    setPartial(null);
    const outcome = await submit.submit({
      run: async (signal) => {
        const res = await announce({
          signal,
          data: { plan_id: plan.id, client_submission_id: announcementId.current },
        });
        if (!res?.announcement_id) throw new Error("The email to members did not go out.");
        return res;
      },
    });
    if (!outcome.ok) return;
    onAnnounced(outcome.value);
    if (outcome.value.pending > 0) {
      // Keep the id: "send the rest" continues this announcement.
      setPartial(outcome.value);
      return;
    }
    setTarget(null);
    submit.reset();
  }

  const panel = (
    <>
      {countError && (
        <p role="alert" className="text-sm text-destructive">
          {countError}. Nothing was saved or sent. Try Save again.
        </p>
      )}
      {(submit.status === "submitting" || submit.status === "slow") && target && (
        <p role="status" className="text-sm text-muted-foreground">
          Saved. Emailing members about {target.name}...
        </p>
      )}
      {submit.status === "failed" && target && (
        <p className="text-sm font-medium">
          {target.name} is saved, but the email to members has not gone out.
        </p>
      )}
      <SubmitStatus
        status={submit.status}
        attempt={submit.attempt}
        attempts={submit.attempts}
        error={submit.error}
        failureKind={submit.failureKind}
        onRetry={() => target && void deliver(target)}
      />
      {partial && target && !submit.busy && (
        <div role="status" className="rounded-md border p-3 text-sm">
          Emailed {partial.emailed} of {partial.recipients} so far. The rest go out with the next
          morning&apos;s summary, or you can send them now.
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={() => void deliver(target)}>
              Send the rest now
            </Button>
          </div>
        </div>
      )}
      {confirmDialog}
    </>
  );

  return { ticked, setTicked, busy: submit.busy, confirmBeforeSave, send, panel };
}
