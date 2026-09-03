import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Pill } from "@/components/site/StatusPill";
import { AddMembershipCard } from "@/components/site/AddMembershipCard";
import { MembershipRowActions } from "@/components/site/MembershipRowActions";
import { formatDate, formatDateOnly, formatDateTime } from "@/lib/dates";
import { BELT_SIZE_HINT, BeltSizeSelect, GiSizeSelect } from "@/components/site/KitSizeSelect";
import {
  type BeltSize,
  type GiSize,
  formatBeltSize,
  formatGiSize,
  isBeltSize,
  isGiSize,
} from "@/lib/kit-sizes";
import {
  ROLE_CLASS,
  coverageClass,
  lifecycleClass,
  mediaConsentClass,
  membershipClass,
  verificationClass,
  waiverClass,
} from "@/lib/status-colours";
import { lifecycleLabel, membershipStatusLabel } from "@/lib/status-labels";
import { mediaConsentLabel, mediaConsentProvenance } from "@/lib/waiver-acknowledgements";
import { cn } from "@/lib/utils";
import {
  deriveExpandedWaivers,
  formatCents,
  isPaperWaiver,
  type WaiverApprovalStatus,
} from "@/lib/validation";
import { emailVerificationLabel, isEmailVerified } from "@/lib/email-verification";
import { isSignedUrlFresh, shouldFetchSignedUrl } from "@/lib/signed-url-cache";
import type { SignedUrlEntry } from "@/lib/signed-url-cache";
import {
  getClubUser,
  resendClubUserVerification,
  setClubUserEmail,
  setClubUserKitSizes,
} from "@/lib/club-user.functions";
import { attachCheckInCoverage, transferCheckInCoverage } from "@/lib/checkin.functions";
import { getWaiverPdfUrl, setWaiverApproval } from "@/lib/waiver.functions";
import { approvalConfirmation, runApproval } from "@/lib/waiver-approval";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useConfirm } from "@/hooks/use-confirm";

export const Route = createFileRoute("/_authenticated/manager/users_/$userId")({
  head: () => ({
    meta: [{ title: "User | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  // Remount on a different person. Without this the router reuses one component
  // instance across /manager/users/A -> /manager/users/B, so an approval's
  // refetch issued for A (its closure holds A's id) could land after B's load
  // and paint A's record, Approve buttons and all, under B's URL.
  remountDeps: ({ params }) => params.userId,
  component: ManagerUserPage,
});

type Detail = Awaited<ReturnType<typeof getClubUser>>;
type Waiver = Detail["waivers"][number];

/** A copy of `record` without `key`. */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{value || "—"}</dd>
    </div>
  );
}

/**
 * Media consent: the club's live answer to "can we photograph this person and
 * use it". View-only on this page: a manager cannot set it on somebody's
 * behalf, the same reason there is no "mark as verified" button on the email
 * card. It can only move two ways, neither of which a manager drives directly:
 * the member changes it themselves on their own account page, or approving a
 * newer waiver that asks about photos copies over what they ticked on it.
 *
 * It gets its own card rather than a row in the read-only Profile grid for two
 * reasons. It is the thing an instructor with a camera actually needs to find
 * in a hurry, and it is the only value here that can move without a new waiver
 * being signed — so it needs somewhere to say where the current answer came
 * from, which a two-line <Field> has no room for.
 */
function MediaConsentCard({
  userId,
  value,
  updatedAt,
  setBy,
  guardianUserId,
  guardianName,
}: {
  userId: string;
  value: boolean | null;
  updatedAt: string | null;
  /**
   * Who last set it by hand: this person themselves, the account holder who
   * looks after them, a manager, or nobody.
   */
  setBy: string | null;
  /** Whose account this person is on, when they are on somebody else's. */
  guardianUserId: string | null;
  /** That person's name, for the sentence. Null when the lookup failed. */
  guardianName: string | null;
}) {
  return (
    <div className="rounded-lg border p-4">
      <h2 className="mb-1 text-lg font-bold">Media consent</h2>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* preserveCase: "Not asked" is a sentence, not an enum value, and the
            default capitalize would render it "Not Asked". */}
        <Pill label={mediaConsentLabel(value)} className={mediaConsentClass(value)} preserveCase />
        <span className="text-sm text-muted-foreground">
          {value === true
            ? "Photos and video of them may be used to promote the club, without naming them."
            : value === false
              ? "Do not use photos or video of them in anything public."
              : "Nobody has recorded an answer. Ask them before using any photo."}
        </span>
      </div>

      {/* Where the current answer came from. The rule is in
          `mediaConsentProvenance`, with its reasoning and its tests: it is one
          sentence, but it makes a statement about who decided something on
          somebody else's behalf, and it got that wrong once already. */}
      <p className="mb-3 text-xs text-muted-foreground">
        {mediaConsentProvenance({
          userId,
          guardianUserId,
          guardianName,
          setBy,
          updatedAt: formatDateTime(updatedAt),
          value,
        })}
      </p>

      <p className="text-xs text-muted-foreground">
        This is read-only here.{" "}
        {guardianUserId
          ? "Whoever holds their account can change it from their page there"
          : "They can change it themselves on their account page"}
        , and approving a newer waiver that asks about photos replaces it with what they ticked on
        it.
      </p>
    </div>
  );
}

/**
 * The signing context blob, rendered as plain rows so nothing is hidden.
 * Emits bare <Field>s: the caller owns the surrounding <dl>.
 */
function SignerMeta({ meta }: { meta: unknown }) {
  const entries =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? Object.entries(meta as Record<string, unknown>)
      : [];
  return (
    <>
      {entries.map(([key, value]) => (
        <Field
          key={key}
          label={key.replace(/_/g, " ")}
          value={Array.isArray(value) ? value.join(", ") : String(value)}
        />
      ))}
    </>
  );
}

/**
 * The person's email address: what it is, whether anyone has proved they can
 * read it, and the two things a manager can do about it.
 *
 * Correcting an address is the only email-editing path in the product, and it
 * always drops the person back to unverified: the new address has never been
 * proven, whatever was true of the old one. There is deliberately no "mark as
 * verified" here, because a badge a manager could set would only ever mean "a
 * manager believed this".
 */
function EmailCard({
  userId,
  email,
  belongsTo,
  emailConfirmedAt,
  onChanged,
}: {
  userId: string;
  email: string | null;
  /**
   * Whose address `email` is, when it is not this person's own. Set only for a
   * dependant, whose mailbox is their guardian's.
   */
  belongsTo: string | null;
  emailConfirmedAt: string | null;
  onChanged: () => void;
}) {
  const changeEmail = useServerFn(setClubUserEmail);
  const resend = useServerFn(resendClubUserVerification);
  const [editing, setEditing] = useState(false);
  // ⚠️ NOT prefilled for a dependant. The address on screen is their
  // GUARDIAN's, so prefilling it here would offer a manager a Save that writes
  // the parent's address onto the child's login, which is precisely the thing
  // nobody wants and which the address's whole reserved shape exists to
  // prevent. Refusing that write outright is #107's (`setClubUserEmail`, in
  // #102's sharp edges); not inviting it is this change's, because this change
  // is what made the field look like a real address worth keeping.
  const [draft, setDraft] = useState(belongsTo ? "" : (email ?? ""));
  const [busy, setBusy] = useState(false);
  const verified = isEmailVerified(emailConfirmedAt);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await changeEmail({ data: { userId, email: draft } });
      if (!res.changed) {
        toast.success("That's already their email. Nothing changed.");
      } else if (res.verificationSent) {
        toast.success("Email updated. We sent a confirmation link to the new address.");
      } else {
        // The address moved but the email did not go out. Say so plainly: the
        // manager is the only one who can act on it, and telling them a link
        // was sent would surface as "the member never got anything" days later.
        toast.warning("Email updated, but we couldn't send the confirmation link. Try resending.");
      }
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update that email.");
    } finally {
      setBusy(false);
    }
  }

  async function sendAgain() {
    setBusy(true);
    try {
      const res = await resend({ data: { userId } });
      toast.success(
        res.alreadyVerified
          ? "That address is already confirmed."
          : "Verification email sent to " + res.email,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send that email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <h2 className="mb-3 text-lg font-bold">Email</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        {belongsTo
          ? `This person is on ${belongsTo}'s account and has no email of their own, so everything about them goes to ${belongsTo}. Change it on ${belongsTo}'s own page.`
          : verified
            ? `Confirmed on ${formatDate(emailConfirmedAt)}, when they opened a link we sent here.`
            : "Nobody has opened a link we sent to this address yet. Approving a waiver emails their account details here, and it is the address they sign in with, so a typo locks them out."}
      </p>

      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <Label htmlFor="member-email">New email</Label>
            <Input
              id="member-email"
              type="email"
              required
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft(email ?? "");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{email ?? "—"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change email
          </Button>
          {!verified && email ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={sendAgain}>
              {busy ? "Sending..." : "Resend verification"}
            </Button>
          ) : null}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Changing this moves their login too. Signed waivers keep the address as it was typed, as
        evidence, so an older submission below can legitimately show a different one.
      </p>
    </div>
  );
}

/**
 * The person's gi and belt sizes, and the way a manager corrects them.
 *
 * Unlike everything in the Profile card above it, no waiver records sizing, so
 * there is no frozen submission for a correction here to disagree with and
 * nothing an approval will later overwrite. That is why this is editable and
 * the rest of the profile is not.
 *
 * Same inline-edit shape as `EmailCard`: a read row with a button, swapped for
 * a form on demand, so the page has one editing idiom rather than two.
 */
function KitSizesCard({
  userId,
  giSize,
  beltSize,
  onChanged,
}: {
  userId: string;
  giSize: string | null;
  beltSize: string | null;
  onChanged: () => void;
}) {
  const saveSizes = useServerFn(setClubUserKitSizes);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const storedGi = giSize && isGiSize(giSize) ? giSize : "";
  const storedBelt = beltSize && isBeltSize(beltSize) ? beltSize : "";
  const [giDraft, setGiDraft] = useState<GiSize | "">(storedGi);
  const [beltDraft, setBeltDraft] = useState<BeltSize | "">(storedBelt);

  // Follow the record while the form is closed, so opening it always starts
  // from what is actually stored. A `useState` initialiser only runs on mount,
  // so without this the draft would still hold whatever the page loaded first
  // after a reload picked up somebody else's change.
  useEffect(() => {
    if (editing) return;
    setGiDraft(storedGi);
    setBeltDraft(storedBelt);
  }, [editing, storedGi, storedBelt]);

  const dirty = giDraft !== storedGi || beltDraft !== storedBelt;

  function reset() {
    setGiDraft(storedGi);
    setBeltDraft(storedBelt);
    setEditing(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await saveSizes({
        data: { userId, gi_size: giDraft || null, belt_size: beltDraft || null },
      });
      toast.success("Sizes updated.");
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update those sizes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <h2 className="mb-3 text-lg font-bold">Kit sizing</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        For ordering a gi and belt, and for sizing loan gear. Members can set these themselves, and
        signing a waiver offers a gi size. No waiver records them, so approving one never changes
        what is here.
      </p>

      {editing ? (
        <form onSubmit={save} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[14rem] flex-1">
              <Label htmlFor="member-gi-size">Gi size</Label>
              <GiSizeSelect
                id="member-gi-size"
                value={giDraft}
                onChange={setGiDraft}
                disabled={busy}
                emptyLabel="Not on file"
                className="mt-1.5"
              />
            </div>
            <div className="min-w-[14rem] flex-1">
              <Label htmlFor="member-belt-size">Belt size</Label>
              <BeltSizeSelect
                id="member-belt-size"
                value={beltDraft}
                onChange={setBeltDraft}
                disabled={busy}
                emptyLabel="Not on file"
                className="mt-1.5"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{BELT_SIZE_HINT}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !dirty}>
              {busy ? "Saving..." : "Save"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={reset}>
              Cancel
            </Button>
            {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Gi <strong>{formatGiSize(giSize) ?? "—"}</strong>
          </span>
          <span className="text-sm">
            Belt <strong>{formatBeltSize(beltSize) ?? "—"}</strong>
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change sizes
          </Button>
        </div>
      )}
    </div>
  );
}

function ManagerUserPage() {
  const { userId } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchDetail = useServerFn(getClubUser);
  const getUrl = useServerFn(getWaiverPdfUrl);
  const approve = useServerFn(setWaiverApproval);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pdfs, setPdfs] = useState<Record<string, SignedUrlEntry>>({});
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const { confirm, confirmDialog } = useConfirm();
  // Only the newest load's result may land: back-to-back approvals each trigger
  // their own refetch. (A different person is a different component instance —
  // see remountDeps above.)
  const loadSeq = useRef(0);
  const pdfInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const attachCoverage = useServerFn(attachCheckInCoverage);
  // Which membership a manager picked for an uncovered check-in, if they chose
  // to override. Blank means "whatever covers it now", which is almost always
  // right: a check-in is uncovered because a payment had not landed yet.
  const [attachChoice, setAttachChoice] = useState<Record<string, string>>({});
  const [attaching, setAttaching] = useState<string | null>(null);

  // The same pair for moving a check-in that IS covered, onto another of their
  // memberships. Required rather than defaulted: re-running the door's own
  // precedence would land it back where it started.
  const moveCoverage = useServerFn(transferCheckInCoverage);
  const [moveChoice, setMoveChoice] = useState<Record<string, string>>({});
  const [moving, setMoving] = useState<string | null>(null);

  const load = useCallback(
    async (resetOpen: boolean) => {
      const seq = ++loadSeq.current;
      const data = await fetchDetail({ data: { userId } });
      if (seq !== loadSeq.current) return null; // a newer load won
      setDetail(data);
      // Only the newest still-pending submission opens by itself; a manager's
      // own expand/collapse choices survive a refetch after an approval.
      if (resetOpen) setOpen(deriveExpandedWaivers(data.waivers));
      return data;
    },
    [fetchDetail, userId],
  );

  // Returns its own cancel flag so the mount effect can drop a late response,
  // while "Try again" calls it with nothing to cancel.
  const retry = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setLoading(true);
      setError(null);
      return load(true)
        .catch((e) => {
          if (!isCancelled()) setError(describeLoadError(e, "Could not load this member"));
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        });
    },
    [load],
  );

  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    void retry(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isManager, retry]);

  // Sign a PDF URL only for panels actually open, and re-sign a stale one:
  // Radix unmounts collapsed content, so re-expanding an old panel remounts the
  // iframe and would otherwise reuse a dead URL. See `signed-url-cache` for the
  // freshness rule.
  const ensurePdfUrl = useCallback(
    async (waiver: Waiver) => {
      if (!waiver.has_pdf) return;
      const cached = pdfs[waiver.id];
      if (!shouldFetchSignedUrl(cached, Date.now())) return;
      if (pdfInFlight.current.has(waiver.id)) return;
      pdfInFlight.current.add(waiver.id);
      // Drop the stale URL before re-signing, so the iframe remounts on the
      // loading line rather than flashing the storage error for an expired one.
      if (cached?.url) setPdfs((prev) => omitKey(prev, waiver.id));
      try {
        const { url } = await getUrl({ data: { id: waiver.id } });
        setPdfs((prev) => ({ ...prev, [waiver.id]: { url, at: Date.now() } }));
      } catch (e) {
        setPdfs((prev) => ({
          ...prev,
          [waiver.id]: {
            at: Date.now(),
            error: e instanceof Error ? e.message : "Could not load the PDF. Try again.",
          },
        }));
      } finally {
        pdfInFlight.current.delete(waiver.id);
      }
    },
    [getUrl, pdfs],
  );

  useEffect(() => {
    if (!detail) return;
    for (const w of detail.waivers) if (open.has(w.id)) void ensurePdfUrl(w);
  }, [detail, open, ensurePdfUrl]);

  async function attachCheckIn(id: string) {
    setAttaching(id);
    try {
      const chosen = attachChoice[id];
      const res = await attachCoverage({
        data: { id, ...(chosen ? { membership_id: chosen } : {}) },
      });
      if (res.decision.coverage === "none") {
        toast.warning("Still nothing covers that class. Sort their membership out first.");
      } else {
        toast.success(`Attached to ${res.decision.plan_name ?? "their membership"}.`);
      }
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not attach that check-in");
    } finally {
      setAttaching(null);
    }
  }

  /** Somewhere else this person's check-in could go. */
  function otherMemberships(membershipId: string | null) {
    return (detail?.memberships ?? []).filter((m) => m.id !== membershipId);
  }

  async function moveCheckIn(id: string) {
    const target = moveChoice[id];
    if (!target) return;
    setMoving(id);
    try {
      const res = await moveCoverage({ data: { id, membership_id: target } });
      // The credit came off the old membership either way — the manager asked
      // for that. Saying so plainly beats a success message over a class that
      // is now uncovered.
      if (res.decision.coverage === "none") {
        toast.warning(
          "That membership cannot cover this class, so it is now uncovered. Pick another one.",
        );
      } else {
        toast.success(`Moved to ${res.decision.plan_name ?? "that membership"}.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that check-in");
    } finally {
      // Reload whatever happened, not only on success. A move that fails part
      // way has already released the check-in and refunded the old membership,
      // so leaving the old coverage on screen would show a state that no longer
      // exists and make the next press argue with an error about it.
      await load(false).catch(() => {});
      setMoving(null);
    }
  }

  function retryPdf(id: string) {
    setPdfs((prev) => omitKey(prev, id));
  }

  function toggle(id: string, next: boolean) {
    setOpen((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  function markApproving(id: string, busy: boolean) {
    setApprovingIds((prev) => {
      const set = new Set(prev);
      if (busy) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  async function setApproval(
    waiver: { id: string; full_name: string },
    status: WaiverApprovalStatus,
  ) {
    // Approving emails the person and opens their login, and nothing on this
    // page can take either back. Revoking only flips the row's status, so it
    // goes through on the click.
    if (status === "approved" && !(await confirm(approvalConfirmation(waiver.full_name)))) return;
    const id = waiver.id;
    markApproving(id, true);
    // Statuses are derived per person (active vs superseded), so refresh by
    // refetching the whole person rather than patching one waiver. `load`
    // answers null when a newer load owns the screen, which stays quiet.
    const outcome = await runApproval({
      status,
      approve: () => approve({ data: { id, status } }),
      refresh: async () => (await load(false)) !== null,
    });
    markApproving(id, false);
    if (outcome.kind !== "stale") toast[outcome.severity](outcome.message);
  }

  async function download(id: string) {
    try {
      const cached = pdfs[id];
      if (isSignedUrlFresh(cached, Date.now())) {
        window.open(cached.url, "_blank", "noopener");
        return;
      }
      const { url } = await getUrl({ data: { id } });
      // Keep the panel in step: this URL is as good as the one it holds, and
      // writing it back clears a stale entry or a recorded error.
      setPdfs((prev) => ({ ...prev, [id]: { url, at: Date.now() } }));
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the PDF. Try again.");
    }
  }

  if (loading) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-10">
        <Loading />
      </section>
    );
  }

  // Two different answers that used to share one line. "User not found" is a
  // fact about the club; a failed read is a fact about the network, and only
  // one of them is worth pressing a button about.
  if (error) {
    return (
      <section className="mx-auto max-w-5xl space-y-4 px-4 py-10">
        <LoadFailure
          what="This member's record"
          message={error}
          hint="This is not the same as them having no waiver, membership or history."
          onRetry={() => void retry()}
        />
        <Button asChild variant="outline">
          <Link to="/manager/users">Back to users</Link>
        </Button>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="mx-auto max-w-5xl space-y-4 px-4 py-10">
        <p className="text-sm text-muted-foreground">User not found.</p>
        <Button asChild variant="outline">
          <Link to="/manager/users">Back to users</Link>
        </Button>
      </section>
    );
  }

  const {
    user: summary,
    profile,
    memberships,
    waivers,
    checkins,
    code_of_conduct: codeOfConduct,
  } = detail;

  return (
    <section className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-3xl font-black">{summary.name ?? summary.email ?? "User"}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              label={lifecycleLabel(summary.lifecycle_status, {
                status: summary.latest_membership_status ?? "",
                kind: summary.latest_plan_kind,
                sessions_remaining: summary.latest_sessions_remaining,
              })}
              preserveCase
              className={lifecycleClass(summary.lifecycle_status)}
            />
            {summary.roles.map((role) => (
              <Pill key={role} label={role} className={ROLE_CLASS} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {/* Every person has an email (it lives on their login record), so a
                missing one here means the lookup failed, not that we hold none. */}
            <span>{summary.email ?? "Email lookup failed"}</span>
            {/* A dependant has no mailbox of their own, so this is their
                guardian's address and the page has to say so. Without it a
                manager reads a child's page and believes they can write to the
                child. Null for every account holder. */}
            {summary.email_belongs_to ? (
              <span>({summary.email_belongs_to}&apos;s address)</span>
            ) : null}
            {summary.email ? (
              <Pill
                label={emailVerificationLabel(summary.email_confirmed_at)}
                className={verificationClass(emailVerificationLabel(summary.email_confirmed_at))}
              />
            ) : null}
            {summary.phone ? <span>· {summary.phone}</span> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            First seen {formatDate(summary.first_seen_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/manager/users">Back to users</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Memberships</Link>
          </Button>
        </div>
      </div>

      <EmailCard
        userId={userId}
        email={summary.email}
        belongsTo={summary.email_belongs_to}
        emailConfirmedAt={summary.email_confirmed_at}
        onChanged={() => void load(false)}
      />

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-bold">Profile</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The club's current record. Approving a waiver copies that submission's details here. The
          two sizes are the exception: no waiver carries them, so they are only ever set by the
          member or by you, in the card below.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Preferred name" value={profile.preferred_name} />
          <Field label="Date of birth" value={formatDateOnly(profile.date_of_birth)} />
          <Field label="Phone" value={profile.phone} />
          <Field label="Address" value={profile.address} />
          <Field label="UTS student number" value={profile.uts_student_number} />
          <Field label="Emergency contact" value={profile.emergency_contact_name} />
          <Field label="Emergency relationship" value={profile.emergency_contact_relationship} />
          <Field label="Emergency phone" value={profile.emergency_contact_phone} />
          <Field label="Medical notes" value={profile.medical_notes} />
          <Field label="Minor" value={profile.is_minor ? "Yes" : "No"} />
          {profile.is_minor ? (
            <>
              <Field label="Guardian" value={profile.guardian_name} />
              <Field label="Guardian relationship" value={profile.guardian_relationship} />
              <Field label="Guardian mobile" value={profile.guardian_phone} />
              <Field label="Guardian email" value={profile.guardian_email} />
              <Field label="Guardian address" value={profile.guardian_address} />
            </>
          ) : null}
          <Field
            label="SMS / WhatsApp consent"
            value={profile.sms_whatsapp_consent ? "Yes" : "No"}
          />
          <Field label="Gi size" value={formatGiSize(profile.gi_size)} />
          <Field label="Belt size" value={formatBeltSize(profile.belt_size)} />
          <Field label="Record updated" value={formatDateTime(profile.updated_at)} />
        </dl>
      </div>

      <KitSizesCard
        userId={userId}
        giSize={profile.gi_size}
        beltSize={profile.belt_size}
        onChanged={() => void load(false)}
      />

      <MediaConsentCard
        userId={userId}
        value={profile.media_consent}
        updatedAt={profile.media_consent_updated_at}
        setBy={profile.media_consent_updated_by}
        guardianUserId={profile.guardian_user_id}
        guardianName={summary.email_belongs_to}
      />

      {/* House rules. Read-only on purpose: a manager cannot tick this on
          somebody's behalf, for the same reason there is no "mark as verified"
          button — an agreement a manager recorded would only mean "a manager
          believed this". It sits here so the state is visible at the moment a
          membership is being set up, which is when the club wants it signed. */}
      <div className="rounded-lg border p-4">
        <h2 className="mb-1 text-lg font-bold">Code of conduct</h2>
        {codeOfConduct.state === "signed" ? (
          <p className="text-sm text-muted-foreground">
            Agreed to version {codeOfConduct.accepted_version} on{" "}
            {formatDate(codeOfConduct.accepted_at)}, signed as {codeOfConduct.signature_name ?? "—"}
            .
          </p>
        ) : codeOfConduct.state === "outdated" ? (
          <p className="text-sm text-muted-foreground">
            Agreed to version {codeOfConduct.accepted_version} on{" "}
            {formatDate(codeOfConduct.accepted_at)}. The current version is{" "}
            {codeOfConduct.current_version}, so it is worth asking them to read it again. Nothing is
            blocked either way.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not signed yet. They can sign it from their account page, or from the link in their
            waiver confirmation email. It does not block training or a membership.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-bold">Memberships</h2>
        {memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No memberships yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2">Starts</th>
                  <th className="px-3 py-2">Ends</th>
                  <th className="px-3 py-2">Sessions left</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{m.plan_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Pill
                        label={membershipStatusLabel(m)}
                        preserveCase
                        className={membershipClass(m.status)}
                      />
                    </td>
                    <td className="px-3 py-2">{formatCents(m.price_cents)}</td>
                    <td className="px-3 py-2">{m.payment_reference ?? "—"}</td>
                    <td className="px-3 py-2">{formatDate(m.starts_at)}</td>
                    <td className="px-3 py-2">{formatDate(m.ends_at)}</td>
                    <td className="px-3 py-2">{m.sessions_remaining ?? "—"}</td>
                    <td className="px-3 py-2">
                      <MembershipRowActions membership={m} onChanged={() => load(false)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AddMembershipCard userId={userId} onAdded={() => load(false)} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-bold">Sessions</h2>
        <p className="text-sm text-muted-foreground">
          {summary.sessions_attended === 0
            ? "They have not been checked in to a class yet."
            : `They have trained ${summary.sessions_attended} time${
                summary.sessions_attended === 1 ? "" : "s"
              }.`}{" "}
          A check-in with no cover can be attached to a membership from the{" "}
          <Link className="underline" to="/manager/check-in">
            check-in screen
          </Link>
          .
        </p>
        {checkins.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Class</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Covered by</th>
                  <th className="px-3 py-2">Used a session</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {checkins.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.event_title ?? "Unknown class"}</td>
                    <td className="px-3 py-2">
                      {formatDateTime(c.event_starts_at ?? c.checked_in_at)}
                    </td>
                    <td className="px-3 py-2">
                      <Pill
                        label={c.coverage === "none" ? "No cover" : (c.plan_name ?? "Membership")}
                        className={coverageClass(c.coverage)}
                        preserveCase
                      />
                    </td>
                    <td className="px-3 py-2">{c.consumed_credit ? "Yes" : "No"}</td>
                    <td className="px-3 py-2">
                      {c.coverage === "none" ? (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <select
                            aria-label="Membership to attach this check-in to"
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm"
                            value={attachChoice[c.id] ?? ""}
                            onChange={(e) =>
                              setAttachChoice((prev) => ({ ...prev, [c.id]: e.target.value }))
                            }
                          >
                            <option value="">Whatever covers it now</option>
                            {memberships.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.plan_name ?? "Membership"} ({membershipStatusLabel(m)}
                                {m.sessions_remaining != null
                                  ? `, ${m.sessions_remaining} left`
                                  : ""}
                                )
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={attaching === c.id}
                            onClick={() => attachCheckIn(c.id)}
                          >
                            Attach
                          </Button>
                        </div>
                      ) : (
                        // Moving a covered check-in is what frees its membership
                        // up to be deleted. Nowhere to move it to when it is
                        // their only membership, so the control stays hidden
                        // rather than offering a no-op.
                        otherMemberships(c.membership_id).length > 0 && (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <select
                              aria-label="Membership to move this check-in to"
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm"
                              value={moveChoice[c.id] ?? ""}
                              onChange={(e) =>
                                setMoveChoice((prev) => ({ ...prev, [c.id]: e.target.value }))
                              }
                            >
                              <option value="">Move to...</option>
                              {otherMemberships(c.membership_id).map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.plan_name ?? "Membership"} ({membershipStatusLabel(m)}
                                  {m.sessions_remaining != null
                                    ? `, ${m.sessions_remaining} left`
                                    : ""}
                                  )
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={moving === c.id || !moveChoice[c.id]}
                              onClick={() => moveCheckIn(c.id)}
                            >
                              Move
                            </Button>
                          </div>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-bold">Waivers</h2>
        <p className="text-sm text-muted-foreground">
          Every submission, newest first. The newest one opens automatically while it still needs a
          decision; approved and older submissions stay collapsed.
        </p>
        {waivers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No waivers signed yet.</p>
        ) : (
          waivers.map((w) => {
            const isOpen = open.has(w.id);
            const busy = approvingIds.has(w.id);
            const pdf = pdfs[w.id];
            return (
              <Collapsible
                key={w.id}
                open={isOpen}
                onOpenChange={(next) => toggle(w.id, next)}
                className="rounded-lg border"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <CollapsibleTrigger className="flex items-center gap-2 text-left">
                    <ChevronDown
                      className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                    />
                    <span>
                      <span className="font-medium">{formatDateTime(w.signed_at)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        v{w.template_version ?? "—"}
                      </span>
                    </span>
                    <Pill label={w.status} className={waiverClass(w.status)} />
                    {isPaperWaiver(w.signer_meta) && (
                      <Pill label="paper" className="bg-muted text-muted-foreground" />
                    )}
                  </CollapsibleTrigger>
                  <div className="flex flex-wrap items-center gap-2">
                    {w.status === "pending" ? (
                      <Button size="sm" onClick={() => setApproval(w, "approved")} disabled={busy}>
                        {busy ? "Approving..." : "Approve"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApproval(w, "pending")}
                        disabled={busy}
                      >
                        {busy ? "Updating..." : "Revoke approval"}
                      </Button>
                    )}
                    {w.has_pdf ? (
                      <Button size="sm" variant="outline" onClick={() => download(w.id)}>
                        <Download className="mr-1 h-3 w-3" /> PDF
                      </Button>
                    ) : null}
                  </div>
                </div>

                <CollapsibleContent>
                  <div className="space-y-4 border-t p-3">
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <Field label="Name as signed" value={w.full_name} />
                      <Field label="Email" value={w.email} />
                      <Field label="Phone" value={w.phone} />
                      <Field label="Date of birth" value={formatDateOnly(w.date_of_birth)} />
                      <Field label="Address" value={w.address} />
                      <Field label="UTS student number" value={w.uts_student_number} />
                      <Field label="Emergency contact" value={w.emergency_contact_name} />
                      <Field
                        label="Emergency relationship"
                        value={w.emergency_contact_relationship}
                      />
                      <Field label="Emergency phone" value={w.emergency_contact_phone} />
                      <Field label="Medical notes" value={w.medical_notes} />
                      <Field label="Minor" value={w.is_minor ? "Yes" : "No"} />
                      {/* Shown whenever the waiver actually NAMES a guardian,
                          not when the participant was under 18. Those came to
                          the same thing until a person could be a dependant at
                          any age: a guardian signs for one of those whatever
                          their birthday, and keyed on `is_minor` their details
                          would be on the signed document and missing from the
                          only screen a manager reads it on. */}
                      {w.guardian_name ? (
                        <>
                          <Field label="Guardian" value={w.guardian_name} />
                          <Field label="Guardian relationship" value={w.guardian_relationship} />
                          <Field label="Guardian mobile" value={w.guardian_phone} />
                          <Field label="Guardian email" value={w.guardian_email} />
                          <Field label="Guardian address" value={w.guardian_address} />
                        </>
                      ) : null}
                      <Field
                        label="SMS / WhatsApp consent"
                        value={w.sms_whatsapp_consent ? "Yes" : "No"}
                      />
                      {/* What was ticked on THIS submission, frozen. The card
                          above is the club's live answer, which a manager may
                          have moved since; the two disagreeing is meaningful,
                          not a bug. */}
                      <Field label="Media consent" value={mediaConsentLabel(w.media_consent)} />
                      <Field label="Approved" value={formatDateTime(w.approved_at)} />
                      <Field label="Approved by" value={w.approved_by_name} />
                    </dl>

                    {!w.has_pdf ? (
                      <p className="text-sm text-muted-foreground">
                        No PDF was stored for this submission.
                      </p>
                    ) : pdf?.error ? (
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="text-muted-foreground">{pdf.error}</span>
                        <Button size="sm" variant="outline" onClick={() => retryPdf(w.id)}>
                          Try again
                        </Button>
                      </div>
                    ) : pdf?.url ? (
                      <iframe
                        src={pdf.url}
                        title={`Signed waiver ${formatDateTime(w.signed_at)}`}
                        referrerPolicy="no-referrer"
                        className="h-[70vh] w-full rounded-md border bg-muted"
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading the signed PDF...</p>
                    )}

                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        {isPaperWaiver(w.signer_meta) ? "Filing record" : "Signing record"}
                      </summary>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        {/* Nobody connected from anywhere to sign a paper form,
                            so an empty "Signer IP" row would read as missing
                            evidence rather than evidence that does not exist. */}
                        {!isPaperWaiver(w.signer_meta) && (
                          <Field label="Signer IP" value={w.signer_ip} />
                        )}
                        <SignerMeta meta={w.signer_meta} />
                      </dl>
                    </details>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </div>
      {confirmDialog}
    </section>
  );
}
