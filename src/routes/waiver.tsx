import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertCircle, CheckCircle2, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SignaturePad, type SignaturePadHandle } from "@/components/site/SignaturePad";
import { GI_SIZE_HINT, GiSizeSelect } from "@/components/site/KitSizeSelect";
import { type GiSize, isGiSize } from "@/lib/kit-sizes";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { WaiverDocument } from "@/components/site/WaiverDocument";
import {
  submitWaiverWithPdf,
  getCurrentWaiverTemplate,
  getMyProfile,
  checkWaiverSubmission,
  type WaiverSubmitResult,
} from "@/lib/waiver.functions";
import { redeemWaiverEmailVerification } from "@/lib/email-verification.functions";
import { applyWaiverPlaceholders, buildWaiverPlaceholders } from "@/lib/waiver-document";
import { resolveAcknowledgements } from "@/lib/waiver-acknowledgements";
import { anyHealthConcern, healthQuestions } from "@/lib/waiver-health";
import {
  ackAnchorId,
  missingFieldsSummary,
  missingWaiverFields,
  WAIVER_ANCHORS,
} from "@/lib/waiver-required-fields";
import { useAuth } from "@/hooks/useAuth";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { WAIVER_SUBMIT } from "@/lib/submit-resilience";
import {
  clearDraft,
  draftHasContent,
  readDraft,
  writeDraft,
  type WaiverDraft,
} from "@/lib/waiver-draft";
import {
  resolveNamePrefill,
  waiverPrefillSearchSchema,
  type HealthAnswers,
  type HealthQuestionId,
} from "@/lib/validation";
import { buildPageMeta } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/waiver")({
  // Optional prefill carried over from Step 1 of the "Start your free trial" flow.
  validateSearch: waiverPrefillSearchSchema,
  head: () => ({
    meta: [
      ...buildPageMeta({
        title: "Sign waiver | UTS Jitsu",
        description: "Complete the UTS Jitsu training waiver before your first class.",
        ogDescription: "Complete the UTS Jitsu training waiver online.",
        path: "/waiver",
      }),
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/waiver" }],
  }),
  component: Waiver,
});

// The profile carries no email — that lives on the auth user, and the form's
// email field is seeded from the session (user.email) instead.
type Prefill = {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
  address?: string | null;
  phone?: string | null;
  uts_student_number?: string | null;
  sms_whatsapp_consent?: boolean | null;
  gi_size?: string | null;
  martial_arts_experience?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  emergency_contact_phone?: string | null;
  medical_notes?: string | null;
};

/** Health answers while the form is being filled in: `null` = not answered yet. */
type HealthDraft = Record<HealthQuestionId, boolean | null>;

const emptyHealthDraft = (): HealthDraft =>
  Object.fromEntries(healthQuestions.map((q) => [q.id, null])) as HealthDraft;

function Waiver() {
  const submit = useServerFn(submitWaiverWithPdf);
  const fetchTemplate = useServerFn(getCurrentWaiverTemplate);
  const fetchMine = useServerFn(getMyProfile);
  const { user, loading: authLoading } = useAuth();
  const search = Route.useSearch();
  const { first_name, last_name, name } = search;
  const prefillName = useMemo(
    () => resolveNamePrefill({ first_name, last_name, name }),
    [first_name, last_name, name],
  );

  const send = useResilientSubmit<WaiverSubmitResult>(WAIVER_SUBMIT);
  const checkSubmission = useServerFn(checkWaiverSubmission);
  // Accepted acknowledgements keyed by the template's acknowledgement id.
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  /**
   * The confirmed outcome. Set only from a server response, never from a toast:
   * the success screen used to be able to appear off the back of a toast that
   * fired whether or not anything came back.
   *
   * `codeOfConductUrl` carries a token, because an applicant cannot log in yet
   * and the code of conduct still has to know who is signing it. Null on a
   * recovery path (a dropped-then-confirmed submit, or a restored pending
   * check on mount): only the original submit response mints the token, and
   * the confirmation email carries the same link independently either way.
   */
  const [result, setResult] = useState<{
    pdfUrl: string | null;
    pdfReady: boolean;
    codeOfConductUrl: string | null;
  } | null>(null);
  /** True once a draft from this browser session has been put back on screen. */
  const [restored, setRestored] = useState(false);
  /** Blocks draft writes until the restore pass has run, so it can't erase one. */
  const [hydrated, setHydrated] = useState(false);

  // Controlled form fields so we can render a live PDF preview. Seed name /
  // contact fields from the Step 1 details when arriving via the trial flow.
  const [firstName, setFirstName] = useState(prefillName.first);
  const [middleName, setMiddleName] = useState(prefillName.middle);
  const [lastName, setLastName] = useState(prefillName.last);
  const [preferredName, setPreferredName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState(search.phone ?? "");
  const [email, setEmail] = useState(search.email ?? "");
  const [address, setAddress] = useState("");
  const [utsStudentNumber, setUtsStudentNumber] = useState("");
  // Equipment sizing, not part of the waiver. Optional, and it goes straight
  // onto the profile rather than onto the signed document.
  const [giSize, setGiSize] = useState<GiSize | "">("");
  // Optional previous martial arts experience, also not part of the waiver
  // (see the fieldset below): straight onto the profile, for instructors.
  const [martialArtsExperience, setMartialArtsExperience] = useState("");
  // SMS/WhatsApp consent is a checkbox here (page 2). It defaults to checked
  // only when the phone number was already collected on the previous page —
  // i.e. the person already gave us their number (and saw the consent note)
  // during the "Start your free trial" step. Otherwise they must opt in.
  const [smsConsent, setSmsConsent] = useState(Boolean(search.phone && search.phone.trim()));
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [health, setHealth] = useState<HealthDraft>(emptyHealthDraft);
  const [medical, setMedical] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [signatureImage, setSignatureImage] = useState("");
  const [signatureMode, setSignatureMode] = useState<"draw" | "type">("draw");
  const [guardianSignature, setGuardianSignature] = useState("");
  const [guardianSignatureImage, setGuardianSignatureImage] = useState("");
  const [guardianSignatureMode, setGuardianSignatureMode] = useState<"draw" | "type">("draw");

  const sigPadRef = useRef<SignaturePadHandle | null>(null);
  const gSigPadRef = useRef<SignaturePadHandle | null>(null);
  /**
   * Whether they have pressed Sign yet.
   *
   * Nothing is marked wrong before that: a half-filled form is not a form full
   * of errors, it is somebody part-way through. From the first press the
   * summary and the field markers track the live state, so each thing they fix
   * drops off the list instead of waiting for another press to be re-checked.
   */
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const fullName = useMemo(
    () =>
      [firstName, middleName, lastName]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" "),
    [firstName, middleName, lastName],
  );

  const isMinor = useMemo(() => {
    if (!dob) return false;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age < 18;
  }, [dob]);

  const templateQ = useQuery({
    queryKey: ["waiver-template"],
    queryFn: () => fetchTemplate(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (authLoading || !user) return;
    // A restored draft is what this person actually typed, so it outranks the
    // stored profile. Without this gate the profile prefill lands after the
    // restore (it waits on the auth session) and quietly overwrites it.
    if (restored) return;
    fetchMine()
      .then((row) => {
        if (!row) return;
        const r = row as Prefill;
        if (r.first_name || r.last_name) {
          setFirstName(r.first_name || "");
          setMiddleName(r.middle_name || "");
          setLastName(r.last_name || "");
        }
        if (r.preferred_name) setPreferredName(r.preferred_name);
        if (r.date_of_birth) setDob(r.date_of_birth);
        if (r.phone) setPhone(r.phone);
        // Prefill the consent checkbox from the member's stored consent (they
        // can still change it).
        if (typeof r.sms_whatsapp_consent === "boolean") setSmsConsent(r.sms_whatsapp_consent);
        if (r.address) setAddress(r.address);
        if (r.uts_student_number) setUtsStudentNumber(r.uts_student_number);
        if (r.gi_size && isGiSize(r.gi_size)) setGiSize(r.gi_size);
        if (r.martial_arts_experience) setMartialArtsExperience(r.martial_arts_experience);
        if (r.emergency_contact_name) setEcName(r.emergency_contact_name);
        if (r.emergency_contact_relationship) setEcRelationship(r.emergency_contact_relationship);
        if (r.emergency_contact_phone) setEcPhone(r.emergency_contact_phone);
        if (r.medical_notes) setMedical(r.medical_notes);
        // The health questions are deliberately NOT prefilled: they are a
        // declaration about today, and a stale "no" carried over from an older
        // waiver is exactly what an instructor must not read as current.
      })
      .catch(() => {
        /* no profile yet */
      });
  }, [authLoading, user, fetchMine, restored]);

  // A signed-in person signs for their own account: the waiver's email is
  // their login email, and the field is locked (the server enforces the match).
  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user]);

  // Lets someone on a shared/previously-signed-in device sign under a
  // different address without leaving the page. Falls back to whatever
  // prefill came in on the URL, since that's the address they were trying to
  // sign under in the first place.
  async function signOutToSignAsSomeoneElse() {
    await supabase.auth.signOut();
    setEmail(search.email ?? "");
  }

  // Arriving from the link in an interest confirmation email is itself proof
  // that the address is real, so redeem it on open rather than waiting for a
  // submission that may never come. Fire and forget: this is a side benefit of
  // landing here, and nothing on the page depends on it. A visitor who has no
  // person record yet is a no-op server-side, and the token stays live so the
  // submission below can still carry the proof into their new record.
  const verificationToken = search.vt;
  const redeemVerification = useServerFn(redeemWaiverEmailVerification);
  useEffect(() => {
    if (!verificationToken) return;
    redeemVerification({ data: { token: verificationToken } }).catch(() => {
      /* verification is best-effort; never surface it to the signer */
    });
  }, [verificationToken, redeemVerification]);

  // ---- Session draft ----
  //
  // Twenty fields, five health answers and a hand-drawn signature. A reload, a
  // crashed mobile tab, or a phone evicting a backgrounded page used to lose all
  // of it, and nobody fills that in twice. See lib/waiver-draft.ts for why this
  // is sessionStorage and not localStorage.

  const adoptSubmissionId = send.adoptSubmissionId;
  /** A restored draft's submission id, still to be checked against the server. */
  const [pendingCheckId, setPendingCheckId] = useState<string | null>(null);

  // Restore once, on mount. In an effect, not during render: the route is SSR'd,
  // and reading sessionStorage while rendering would break hydration.
  useEffect(() => {
    const draft = readDraft();
    if (!draft) {
      setHydrated(true);
      return;
    }
    // Reuse the draft's id even when there is nothing worth restoring, so a
    // submission that was in flight when the tab died can still be identified.
    adoptSubmissionId(draft.submissionId);
    if (draftHasContent(draft)) {
      setFirstName(draft.firstName);
      setMiddleName(draft.middleName);
      setLastName(draft.lastName);
      setPreferredName(draft.preferredName);
      setDob(draft.dob);
      setPhone(draft.phone);
      setEmail(draft.email);
      setAddress(draft.address);
      setUtsStudentNumber(draft.utsStudentNumber);
      setSmsConsent(draft.smsConsent);
      setGiSize(isGiSize(draft.giSize) ? draft.giSize : "");
      setMartialArtsExperience(draft.martialArtsExperience);
      setEcName(draft.ecName);
      setEcRelationship(draft.ecRelationship);
      setEcPhone(draft.ecPhone);
      setHealth((prev) => ({ ...prev, ...draft.health }));
      setMedical(draft.medical);
      setAcks(draft.acks);
      setSignatureMode(draft.signatureMode);
      setSignatureName(draft.signatureName);
      setSignatureImage(draft.signatureImage);
      setGuardianSignatureMode(draft.guardianSignatureMode);
      setGuardianSignature(draft.guardianSignature);
      setGuardianSignatureImage(draft.guardianSignatureImage);
      setRestored(true);
      setPendingCheckId(draft.submissionId);
    }
    setHydrated(true);
  }, [adoptSubmissionId]);

  // The tab may have died mid-submit. Ask whether that one landed before showing
  // somebody a form to fill in again: the answer is cheap, and signing a second
  // waiver because the first reply was lost is exactly what we are avoiding.
  useEffect(() => {
    if (!pendingCheckId) return;
    let cancelled = false;
    checkSubmission({ data: { client_submission_id: pendingCheckId } })
      .then((res) => {
        if (cancelled || !res.found) return;
        setResult({ pdfUrl: res.pdf_url, pdfReady: Boolean(res.pdf_url), codeOfConductUrl: null });
        clearDraft();
      })
      .catch(() => {
        /* best-effort: an unanswerable check just leaves the form as it is */
      });
    return () => {
      cancelled = true;
    };
  }, [pendingCheckId, checkSubmission]);

  const draftSnapshot = useMemo<WaiverDraft>(
    () => ({
      submissionId: send.submissionId,
      firstName,
      middleName,
      lastName,
      preferredName,
      dob,
      phone,
      email,
      address,
      utsStudentNumber,
      smsConsent,
      giSize,
      martialArtsExperience,
      ecName,
      ecRelationship,
      ecPhone,
      health,
      medical,
      acks,
      signatureMode,
      signatureName,
      signatureImage,
      guardianSignatureMode,
      guardianSignature,
      guardianSignatureImage,
    }),
    [
      send.submissionId,
      firstName,
      middleName,
      lastName,
      preferredName,
      dob,
      phone,
      email,
      address,
      utsStudentNumber,
      smsConsent,
      giSize,
      martialArtsExperience,
      ecName,
      ecRelationship,
      ecPhone,
      health,
      medical,
      acks,
      signatureMode,
      signatureName,
      signatureImage,
      guardianSignatureMode,
      guardianSignature,
      guardianSignatureImage,
    ],
  );

  // Debounced so typing does not serialise a signature PNG on every keystroke.
  // Gated on `hydrated` so the first render cannot overwrite a stored draft with
  // an empty form before the restore above has had a chance to run.
  useEffect(() => {
    if (!hydrated || result) return;
    const timer = setTimeout(() => writeDraft(draftSnapshot), 500);
    return () => clearTimeout(timer);
  }, [hydrated, result, draftSnapshot]);

  /** Throw away a restored draft and start over, for someone signing afresh. */
  function startFresh() {
    clearDraft();
    window.location.assign("/waiver");
  }

  // ---- Live preview (HTML rendering of the waiver, mirrors the PDF) ----
  const previewSignatureImage = signatureMode === "draw" ? signatureImage : "";
  const previewGuardianSignatureImage =
    guardianSignatureMode === "draw" ? guardianSignatureImage : "";
  // Fills the {{signed_date}} token; the `draft` flag independently keeps the
  // "signed on" footer and watermark in their unsigned state.
  const previewSignedAt = useMemo(() => new Date().toISOString(), []);

  // Acknowledgements come from the current template; their labels may use
  // {{placeholders}} (e.g. {{club_name}}), substituted the same way as the body.
  // A "yes" to any health question is what makes the details box required.
  const healthConcern = anyHealthConcern(health);

  const ackDefs = templateQ.data?.acknowledgements ?? [];
  const ackPlaceholders = buildWaiverPlaceholders({
    fullName,
    firstName,
    preferredName,
    dateOfBirth: dob,
    address,
    phone,
    email,
    emergencyContactName: ecName,
    emergencyContactRelationship: ecRelationship,
    emergencyContactPhone: ecPhone,
    medicalNotes: medical,
    healthAnswers: health,
    signatureName: signatureMode === "type" ? signatureName : "",
    clubName: "UTS Jitsu",
    isMinor,
    signedDate: new Date(previewSignedAt).toLocaleDateString("en-AU"),
  });

  // What is still outstanding, recomputed every render so the summary and the
  // field markers below can never disagree with the form. Labels are
  // substituted first, so the summary names an acknowledgement the way the
  // signer just read it rather than showing them a raw {{token}}.
  const missing = missingWaiverFields({
    firstName,
    lastName,
    dob,
    phone,
    email,
    address,
    ecName,
    ecRelationship,
    ecPhone,
    health,
    medical,
    ackDefs: ackDefs.map((ack) => ({
      ...ack,
      label: applyWaiverPlaceholders(ack.label, ackPlaceholders),
    })),
    acks,
    signatureMode,
    signatureName,
    signatureImage,
    isMinor,
    guardianSignatureMode,
    guardianSignature,
    guardianSignatureImage,
  });
  const showMissing = attemptedSubmit && missing.length > 0;
  const missingByAnchor = new Map(missing.map((field) => [field.anchorId, field]));
  /** True for a control the summary is currently pointing at. */
  const flagged = (anchorId: string) => showMissing && missingByAnchor.has(anchorId);
  /** The id its message carries, so the control can point at it. */
  const messageId = (anchorId: string) => `${anchorId}_needed`;
  /**
   * What a flagged control has to say about itself, whatever kind of control it
   * is. The jump is the point: focus lands on the field with the summary
   * possibly scrolled away, so the control has to carry both the state and the
   * sentence, or a screen reader announces an invalid field and nothing about
   * what it wants. Every flagged control gets these, not just the text inputs.
   */
  const flaggedProps = (anchorId: string) => ({
    "aria-invalid": flagged(anchorId) || undefined,
    "aria-describedby": flagged(anchorId) ? messageId(anchorId) : undefined,
  });
  /** The same, plus how a flagged input looks. */
  const fieldProps = (anchorId: string) => ({
    ...flaggedProps(anchorId),
    className: cn(
      "mt-1.5",
      flagged(anchorId) && "border-destructive focus-visible:ring-destructive",
    ),
  });
  /**
   * The line under a flagged control, in the same words the summary used.
   *
   * Every flagged control gets one: a red border is a colour, and somebody who
   * cannot pick it out, or who arrived by jumping straight to the field with
   * the summary now scrolled away, would otherwise have nothing telling them
   * what this field wants.
   */
  const fieldMessage = (anchorId: string) => {
    const field = flagged(anchorId) ? missingByAnchor.get(anchorId) : undefined;
    if (!field) return null;
    return (
      <p id={messageId(anchorId)} className="mt-1.5 text-xs font-medium text-destructive">
        {field.hint ? `${field.hint}.` : "Please fill this in."}
      </p>
    );
  };

  /**
   * Take the signer to a field, the same way from the summary's jump links and
   * from pressing Sign.
   *
   * A frame first: the summary appears in the same commit that calls this, and
   * measuring before it has laid out scrolls to where the field used to be.
   * `preventScroll` then stops the focus from fighting the smooth scroll.
   */
  function goToField(anchorId: string) {
    requestAnimationFrame(() => {
      const el = document.getElementById(anchorId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    });
  }

  /**
   * Send the waiver, and keep sending it.
   *
   * Split out from the form's submit handler so the failure panel's "Try again"
   * runs exactly the same path, with the same submission id. Everything the
   * server needs is read from state, so nothing has to be threaded through.
   */
  async function sendWaiver() {
    const sigImg = signatureMode === "draw" ? signatureImage : "";
    const sigName = signatureMode === "type" ? signatureName : "";

    const outcome = await send.submit({
      run: async (signal, submissionId) => {
        const res = await submit({
          signal,
          data: {
            // The same id on every attempt. It is what lets the server
            // recognise a retry as this waiver rather than signing a second
            // one, and what `confirm` below asks about.
            client_submission_id: submissionId,
            first_name: firstName,
            middle_name: middleName,
            last_name: lastName,
            preferred_name: preferredName,
            date_of_birth: dob,
            address,
            phone,
            email,
            uts_student_number: utsStudentNumber,
            gi_size: giSize,
            martial_arts_experience: martialArtsExperience,
            sms_whatsapp_consent: smsConsent,
            emergency_contact_name: ecName,
            emergency_contact_relationship: ecRelationship,
            emergency_contact_phone: ecPhone,
            // Every question is answered by this point (guarded below), so the
            // draft narrows to the five booleans the server requires.
            health_answers: health as HealthAnswers,
            medical_notes: medical,
            acknowledgements: acks,
            signature_name: sigName,
            signature_image: sigImg,
            is_minor: isMinor,
            guardian_signature: guardianSignatureMode === "type" ? guardianSignature : "",
            guardian_signature_image:
              guardianSignatureMode === "draw" ? guardianSignatureImage : "",
            // The version on screen, so the server refuses to file this against a
            // template that was promoted while the form was being filled in.
            template_version: templateQ.data?.version,
            // Browser context stored with the submission as signing evidence.
            client_meta: {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
              screen: `${window.screen.width}x${window.screen.height}`,
              viewport: `${window.innerWidth}x${window.innerHeight}`,
              platform: navigator.platform ?? "",
              languages: [...(navigator.languages ?? [])].slice(0, 10),
            },
            // Carries the interest email's proof into the person record created
            // by this submission. Re-checked server-side against the email
            // actually submitted, so editing the email field forfeits it.
            vt: verificationToken ?? "",
            hp: "",
          },
        });
        // Only the server gets to say this is signed. The old code showed a
        // success toast unconditionally, so "Waiver signed" could appear over a
        // response that carried nothing.
        if (!res?.ok) throw new Error("We couldn't save your waiver. Please try again.");
        return res;
      },
      // A lost reply is not an answer. Before retrying, ask whether this exact
      // submission already landed: if it did, the person is finished and must
      // not be sent back to the form.
      confirm: async (submissionId, signal) => {
        const res = await checkSubmission({ signal, data: { client_submission_id: submissionId } });
        if (!res.found || !res.waiver_id) return null;
        return {
          ok: true as const,
          waiver_id: res.waiver_id,
          pdf_url: res.pdf_url,
          pdf_ready: Boolean(res.pdf_url),
          // This recovery path re-derives the outcome from `checkWaiverSubmission`,
          // which answers only "did it land" and carries no token; the original
          // attempt's confirmation email already has the working link.
          code_of_conduct_url: null,
        };
      },
    });

    if (outcome.ok) {
      setResult({
        pdfUrl: outcome.value.pdf_url,
        pdfReady: outcome.value.pdf_ready,
        codeOfConductUrl: outcome.value.code_of_conduct_url,
      });
      // Signed and recorded: the draft has done its job, and it holds health
      // answers and a signature that should not outlive it.
      clearDraft();
    }
  }

  /**
   * The client-side checks, run before anything is sent.
   *
   * Both the submit button and the failure panel's "Try again" go through this.
   * The form stays editable behind a failure, so a retry that skipped these
   * could send a waiver whose signature had since been cleared, or one whose
   * date of birth now makes the signer a minor with no guardian signature. The
   * server would reject it, and the signer would be shown a raw Zod issue dump
   * instead of the plain sentence they get here.
   *
   * One answer for every field: the summary lists all of them at once and the
   * page goes to the first, whether the browser could have checked it or not.
   */
  function readyToSend(): boolean {
    setAttemptedSubmit(true);
    if (missing.length === 0) return true;
    goToField(missing[0].anchorId);
    return false;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!readyToSend()) return;
    await sendWaiver();
  }

  function onRetry() {
    if (!readyToSend()) return;
    void sendWaiver();
  }

  // Shown only for a confirmed server response. The waiver being saved and the
  // PDF copy being ready are two different facts, and conflating them is what
  // used to report a perfectly good signed waiver as a failure.
  if (result) {
    return (
      <SiteLayout>
        <section className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
          <CheckCircle2 className="h-16 w-16 text-primary" />
          <h1 className="mt-6 text-3xl font-bold md:text-4xl">Waiver signed</h1>
          {result.pdfReady && result.pdfUrl ? (
            <>
              <p className="mt-3 text-muted-foreground">
                Thanks. A copy has been saved. Download your signed waiver PDF below.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button asChild size="lg">
                  <a href={result.pdfUrl} target="_blank" rel="noopener" download>
                    <Download className="mr-2 h-4 w-4" /> Download waiver PDF
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/">Back home</Link>
                </Button>
              </div>
              <p className="mt-6 text-xs text-muted-foreground">
                The download link expires in 1 hour. Signed-in members can re-download from their
                account.
              </p>
            </>
          ) : (
            <>
              <p className="mt-3 text-muted-foreground">
                Thanks, your waiver is signed and saved. We couldn't get your PDF copy ready just
                now, so there is no download here. You do not need to sign again. We've let the club
                know, and you can reply to your confirmation email any time if you want a copy.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Button asChild size="lg">
                  <Link to="/">Back home</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/classes">See classes</Link>
                </Button>
              </div>
            </>
          )}

          {/* The code of conduct, offered while they are still here. It is not
              required before training, so this is an invitation and not a step:
              the same link is in their confirmation email if they close the tab.
              A plain anchor because the link carries a token in its query.
              Independent of whether the PDF rendered: both branches above get it. */}
          {result.codeOfConductUrl && (
            <div className="mt-10 w-full rounded-2xl border bg-card p-6 text-left">
              <h2 className="text-lg font-bold">One more thing, when you have a minute</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Please read our code of conduct and agree to it. It covers how we train together:
                hygiene, mat etiquette, gear, and keeping each other safe. You can train before you
                do this, and we have emailed you the same link so you can come back to it.
              </p>
              <Button asChild className="mt-4">
                <a href={result.codeOfConductUrl}>Read the code of conduct</a>
              </Button>
            </div>
          )}
        </section>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-3xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Waiver</p>
        <h1 className="mt-3 text-4xl font-bold">Training waiver</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Please complete the waiver before your first training session. Your details are kept
          private and used only for club administration.
        </p>

        <div className="mt-8">
          {/* noValidate because the checking is ours: the browser would stop the
              submit at its own first `required` field with a bubble that fades,
              and the fields it cannot see (health answers, ticks, signature)
              would still be reported separately. One set of rules, one summary. */}
          <form
            onSubmit={onSubmit}
            noValidate
            className="space-y-6 rounded-2xl border bg-card p-6 md:p-8"
          >
            <input type="hidden" name="hp" value="" />

            {restored && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                We brought back what you had already filled in. Check it over before you sign.{" "}
                <button
                  type="button"
                  onClick={startFresh}
                  className="underline hover:text-foreground"
                >
                  Start fresh instead
                </button>
              </p>
            )}

            {user && (
              <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
                Signed in as {user.email}. Your details have been pre-filled from your profile.
              </p>
            )}

            {/* Everything outstanding, in the order the form asks for it. It
                stays on screen and re-counts itself as they work down it, and
                every line is a link back to the field it is about.

                `polite` overrides the assertive that role="alert" implies:
                because the list re-counts on every keystroke, assertive would
                interrupt a screen reader each time a field is completed, which
                is the opposite of helpful while somebody is working down it. */}
            {showMissing && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {missingFieldsSummary(missing.length)}
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {missing.map((field) => (
                    <li key={field.anchorId}>
                      <button
                        type="button"
                        onClick={() => goToField(field.anchorId)}
                        className="text-left underline underline-offset-2 hover:no-underline"
                      >
                        {field.label}
                      </button>
                      {field.hint && <span className="text-muted-foreground"> ({field.hint})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <fieldset className="space-y-5">
              <legend className="text-sm font-semibold">Your details</legend>
              <div className="grid gap-5 sm:grid-cols-3">
                <div>
                  <Label htmlFor="first_name">First name</Label>
                  <Input
                    id="first_name"
                    required
                    maxLength={60}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    {...fieldProps("first_name")}
                  />
                  {fieldMessage("first_name")}
                </div>
                <div>
                  <Label htmlFor="middle_name">
                    Middle name <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="middle_name"
                    maxLength={60}
                    value={middleName}
                    onChange={(e) => setMiddleName(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="last_name">Last name</Label>
                  <Input
                    id="last_name"
                    required
                    maxLength={60}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    {...fieldProps("last_name")}
                  />
                  {fieldMessage("last_name")}
                </div>
              </div>
              <div>
                <Label htmlFor="preferred_name">
                  Preferred name <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="preferred_name"
                  maxLength={60}
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="What you'd like us to call you"
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Only if it's different from your first name. It's what we'll call you in class and
                  in any email we send you.
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="date_of_birth">Date of birth</Label>
                  <Input
                    id="date_of_birth"
                    type="date"
                    required
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                    {...fieldProps("date_of_birth")}
                  />
                  {fieldMessage("date_of_birth")}
                  {/* The paper form's "participant type" tick box. It follows
                      from the date of birth, so we show which one applies
                      rather than asking the same thing twice. */}
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {!dob
                      ? "This decides whether you sign as an adult or a guardian signs for you."
                      : isMinor
                        ? "Under 18, so a parent or guardian consents and signs at the end."
                        : "18 or over, so you sign as the applicant."}
                  </p>
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    required
                    maxLength={30}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    {...fieldProps("phone")}
                  />
                  {fieldMessage("phone")}
                  <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={smsConsent}
                      onCheckedChange={(v) => setSmsConsent(v === true)}
                      className="mt-0.5"
                      aria-label="Consent to SMS or WhatsApp contact"
                    />
                    <span>
                      I agree to be contacted by SMS or WhatsApp, and added to club WhatsApp groups.
                    </span>
                  </label>
                </div>
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  maxLength={255}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={Boolean(user)}
                  {...fieldProps("email")}
                />
                {fieldMessage("email")}
                {user && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    You're signed in, so the waiver uses your account email.
                    <br />
                    Wrong email?{" "}
                    <button
                      type="button"
                      onClick={signOutToSignAsSomeoneElse}
                      className="underline hover:text-foreground"
                    >
                      Log out
                    </button>{" "}
                    to sign under a different address, or{" "}
                    <Link to="/contact" className="underline hover:text-foreground">
                      contact us
                    </Link>{" "}
                    to change the email on your account.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  required
                  maxLength={300}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  {...fieldProps("address")}
                />
                {fieldMessage("address")}
              </div>
              <div>
                <Label htmlFor="uts_student_number">
                  UTS student number <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="uts_student_number"
                  maxLength={20}
                  value={utsStudentNumber}
                  onChange={(e) => setUtsStudentNumber(e.target.value)}
                  placeholder="e.g. 12345678"
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  UTS students train at a discounted rate. Add your number here and the student rate
                  applies when you join.
                </p>
              </div>
              <div>
                <Label htmlFor="gi_size">
                  Gi size <span className="text-muted-foreground">(optional)</span>
                </Label>
                <GiSizeSelect id="gi_size" value={giSize} onChange={setGiSize} className="mt-1.5" />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The number in brackets is the wearer's height that gi size is cut for.{" "}
                  {GI_SIZE_HINT} This is just so we can order kit that fits, and it is not part of
                  the waiver. You can change it any time from your account.
                </p>
              </div>
              <div>
                <Label htmlFor="martial_arts_experience">
                  Previous martial arts experience{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="martial_arts_experience"
                  maxLength={500}
                  value={martialArtsExperience}
                  onChange={(e) => setMartialArtsExperience(e.target.value)}
                  placeholder="e.g. total beginner, 2 years BJJ..."
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  So your instructors know a bit about you before your first class. This is not part
                  of the waiver.
                </p>
              </div>
            </fieldset>

            <fieldset className="space-y-5 border-t pt-6">
              <legend className="text-sm font-semibold">Emergency contact / guardian</legend>
              {isMinor && (
                <p className="text-xs text-muted-foreground">
                  The participant is under 18, so this is the parent or legal guardian who signs at
                  the end of the form.
                </p>
              )}
              <div className="grid gap-5 sm:grid-cols-3">
                <div>
                  <Label htmlFor="emergency_contact_name">Contact name</Label>
                  <Input
                    id="emergency_contact_name"
                    required
                    maxLength={120}
                    value={ecName}
                    onChange={(e) => setEcName(e.target.value)}
                    {...fieldProps("emergency_contact_name")}
                  />
                  {fieldMessage("emergency_contact_name")}
                </div>
                <div>
                  <Label htmlFor="emergency_contact_relationship">Relationship</Label>
                  <Input
                    id="emergency_contact_relationship"
                    required
                    maxLength={80}
                    value={ecRelationship}
                    onChange={(e) => setEcRelationship(e.target.value)}
                    placeholder="Parent, partner, friend"
                    {...fieldProps("emergency_contact_relationship")}
                  />
                  {fieldMessage("emergency_contact_relationship")}
                </div>
                <div>
                  <Label htmlFor="emergency_contact_phone">Contact mobile</Label>
                  <Input
                    id="emergency_contact_phone"
                    type="tel"
                    required
                    maxLength={30}
                    value={ecPhone}
                    onChange={(e) => setEcPhone(e.target.value)}
                    {...fieldProps("emergency_contact_phone")}
                  />
                  {fieldMessage("emergency_contact_phone")}
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-5 border-t pt-6">
              <legend className="text-sm font-semibold">Health declaration</legend>
              <p className="text-xs text-muted-foreground">
                Please answer all five. Your instructors read these before you train.
              </p>
              {healthQuestions.map((q) => (
                <div key={q.id} className="space-y-2">
                  <p className="text-sm">{q.question}</p>
                  <RadioGroup
                    className="flex gap-6"
                    aria-label={q.question}
                    {...flaggedProps(`${q.id}_yes`)}
                    value={health[q.id] === null ? "" : health[q.id] ? "yes" : "no"}
                    onValueChange={(v) => setHealth((prev) => ({ ...prev, [q.id]: v === "yes" }))}
                  >
                    <label className="flex items-center gap-2 text-sm" htmlFor={`${q.id}_yes`}>
                      <RadioGroupItem value="yes" id={`${q.id}_yes`} />
                      Yes
                    </label>
                    <label className="flex items-center gap-2 text-sm" htmlFor={`${q.id}_no`}>
                      <RadioGroupItem value="no" id={`${q.id}_no`} />
                      No
                    </label>
                  </RadioGroup>
                  {fieldMessage(`${q.id}_yes`)}
                </div>
              ))}
              <div>
                <Label htmlFor="medical_notes">
                  Details of anything you answered yes to
                  {healthConcern ? (
                    <span className="text-primary"> (required)</span>
                  ) : (
                    <span className="text-muted-foreground"> (optional)</span>
                  )}
                </Label>
                <Textarea
                  id="medical_notes"
                  required={healthConcern}
                  maxLength={2000}
                  rows={4}
                  value={medical}
                  onChange={(e) => setMedical(e.target.value)}
                  placeholder="Medication, injuries, conditions, anything else our instructors should know"
                  {...fieldProps("medical_notes")}
                />
                {fieldMessage("medical_notes")}
              </div>
              <p className="text-xs text-muted-foreground">
                Privacy note: we collect this health information only to keep you (or the minor)
                safe while training.
              </p>
            </fieldset>

            {ackDefs.length > 0 && (
              <fieldset className="space-y-4 border-t pt-6">
                <legend className="text-sm font-semibold">Acknowledgements</legend>
                {ackDefs.map((ack) => (
                  <div key={ack.id}>
                    <label className="flex items-start gap-3 text-sm">
                      <Checkbox
                        id={ackAnchorId(ack.id)}
                        checked={acks[ack.id] === true}
                        {...flaggedProps(ackAnchorId(ack.id))}
                        onCheckedChange={(v) =>
                          setAcks((prev) => ({ ...prev, [ack.id]: v === true }))
                        }
                        className={cn(
                          "mt-0.5",
                          flagged(ackAnchorId(ack.id)) && "border-destructive",
                        )}
                      />
                      <span>
                        {applyWaiverPlaceholders(ack.label, ackPlaceholders)}
                        {!ack.required && (
                          <span className="text-muted-foreground"> (optional)</span>
                        )}
                      </span>
                    </label>
                    <div className="pl-7">{fieldMessage(ackAnchorId(ack.id))}</div>
                  </div>
                ))}
              </fieldset>
            )}

            <div className="space-y-3 border-t pt-6">
              <div>
                <p className="text-sm font-semibold">Review your waiver</p>
                <p className="text-xs text-muted-foreground">
                  This is exactly what you're about to sign. Please read it before signing below.
                </p>
              </div>
              {templateQ.data ? (
                <WaiverDocument
                  draft
                  clubName="UTS Jitsu"
                  templateTitle={templateQ.data.title}
                  templateBody={templateQ.data.body_md}
                  templateVersion={null}
                  signedAt={previewSignedAt}
                  fullName={fullName}
                  firstName={firstName}
                  preferredName={preferredName}
                  dateOfBirth={dob}
                  address={address}
                  phone={phone}
                  email={email}
                  emergencyContactName={ecName}
                  emergencyContactRelationship={ecRelationship}
                  emergencyContactPhone={ecPhone}
                  medicalNotes={medical}
                  healthAnswers={health}
                  acknowledgements={resolveAcknowledgements(ackDefs, acks)}
                  signatureName={signatureMode === "type" ? signatureName : ""}
                  signatureImage={previewSignatureImage}
                  isMinor={isMinor}
                  guardianName={ecName}
                  guardianRelationship={ecRelationship}
                  guardianSignature={guardianSignatureMode === "type" ? guardianSignature : ""}
                  guardianSignatureImage={previewGuardianSignatureImage}
                />
              ) : (
                <div className="flex h-64 items-center justify-center rounded-xl border bg-muted/30 text-sm text-muted-foreground">
                  Preparing preview...
                </div>
              )}
            </div>

            <fieldset className="space-y-3 border-t pt-6">
              <legend className="text-sm font-semibold">Signature</legend>
              <p className="text-sm text-muted-foreground">
                By signing below, you confirm you've read and agree to the waiver above.
              </p>
              {/* tabIndex so the summary can send someone here while they are
                  drawing: the pad is a canvas, which takes no focus of its own,
                  and the id has to land on something focusable for the jump to
                  read as arriving somewhere. */}
              <div
                id={WAIVER_ANCHORS.signaturePad}
                tabIndex={-1}
                role="group"
                aria-label="Your signature"
                {...flaggedProps(WAIVER_ANCHORS.signaturePad)}
                className={cn(
                  "rounded-lg outline-none",
                  flagged(WAIVER_ANCHORS.signaturePad) && "border border-destructive p-3",
                )}
              >
                <Tabs
                  value={signatureMode}
                  onValueChange={(v) => setSignatureMode(v as "draw" | "type")}
                >
                  <TabsList className="grid w-full max-w-xs grid-cols-2">
                    <TabsTrigger value="draw">Draw</TabsTrigger>
                    <TabsTrigger value="type">Type</TabsTrigger>
                  </TabsList>
                  <TabsContent value="draw" className="mt-3">
                    {/* The pad mounts before the draft restore effect runs, so a
                        restored signature would arrive too late for it. Keying on
                        `restored` remounts it once, with the signature showing. */}
                    <SignaturePad
                      key={restored ? "restored" : "fresh"}
                      ref={sigPadRef}
                      onChange={setSignatureImage}
                      initialDataUrl={signatureImage}
                      ariaLabel="Your signature"
                    />
                  </TabsContent>
                  <TabsContent value="type" className="mt-3">
                    <Label htmlFor="signature_name">Type your full name to sign</Label>
                    <Input
                      id={WAIVER_ANCHORS.signatureName}
                      maxLength={120}
                      value={signatureName}
                      onChange={(e) => setSignatureName(e.target.value)}
                      placeholder="Your full name"
                      {...fieldProps(WAIVER_ANCHORS.signatureName)}
                    />
                    {fieldMessage(WAIVER_ANCHORS.signatureName)}
                  </TabsContent>
                </Tabs>
                {fieldMessage(WAIVER_ANCHORS.signaturePad)}
              </div>
              <p className="text-xs text-muted-foreground">
                By signing and submitting this form, you agree it constitutes an electronic
                signature dated {new Date().toLocaleDateString()}.
              </p>

              {isMinor && (
                <div className="mt-4 space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="text-sm font-medium text-primary">
                    Participant is under 18, so a parent or legal guardian signs as well.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ecName || "The contact"}
                    {ecRelationship ? ` (${ecRelationship})` : ""} signs below, taken from the
                    emergency contact section above. Change it there if someone else is signing.
                  </p>
                  <div
                    id={WAIVER_ANCHORS.guardianPad}
                    tabIndex={-1}
                    role="group"
                    aria-label="Parent or guardian signature"
                    {...flaggedProps(WAIVER_ANCHORS.guardianPad)}
                    className={cn(
                      "rounded-lg outline-none",
                      flagged(WAIVER_ANCHORS.guardianPad) && "border border-destructive p-3",
                    )}
                  >
                    <Label>Parent/guardian signature</Label>
                    <Tabs
                      value={guardianSignatureMode}
                      onValueChange={(v) => setGuardianSignatureMode(v as "draw" | "type")}
                      className="mt-2"
                    >
                      <TabsList className="grid w-full max-w-xs grid-cols-2">
                        <TabsTrigger value="draw">Draw</TabsTrigger>
                        <TabsTrigger value="type">Type</TabsTrigger>
                      </TabsList>
                      <TabsContent value="draw" className="mt-3">
                        <SignaturePad
                          key={restored ? "restored" : "fresh"}
                          ref={gSigPadRef}
                          onChange={setGuardianSignatureImage}
                          initialDataUrl={guardianSignatureImage}
                          ariaLabel="Guardian signature"
                        />
                      </TabsContent>
                      <TabsContent value="type" className="mt-3">
                        <Input
                          id={WAIVER_ANCHORS.guardianName}
                          maxLength={120}
                          value={guardianSignature}
                          onChange={(e) => setGuardianSignature(e.target.value)}
                          placeholder="Guardian full name"
                          {...fieldProps(WAIVER_ANCHORS.guardianName)}
                        />
                        {fieldMessage(WAIVER_ANCHORS.guardianName)}
                      </TabsContent>
                    </Tabs>
                    {fieldMessage(WAIVER_ANCHORS.guardianPad)}
                  </div>
                </div>
              )}
            </fieldset>

            <Button type="submit" size="lg" disabled={send.busy} className="w-full">
              {send.busy ? "Signing your waiver..." : "Sign and download waiver"}
            </Button>

            <SubmitStatus
              status={send.status}
              attempt={send.attempt}
              attempts={send.attempts}
              error={send.error}
              failureKind={send.failureKind}
              onRetry={onRetry}
              fallback={
                <p className="text-sm text-muted-foreground">
                  Everything you filled in is saved on this device, so you can come back to this
                  page and finish. You can also just turn up and sign at the gym.
                </p>
              }
            />
          </form>
        </div>
      </section>
    </SiteLayout>
  );
}
