import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckCircle2, Download } from "lucide-react";
import { SignaturePad, type SignaturePadHandle } from "@/components/site/SignaturePad";
import { WaiverDocument } from "@/components/site/WaiverDocument";
import {
  submitWaiverWithPdf,
  getCurrentWaiverTemplate,
  getMyProfile,
} from "@/lib/waiver.functions";
import { redeemWaiverEmailVerification } from "@/lib/email-verification.functions";
import { applyWaiverPlaceholders, buildWaiverPlaceholders } from "@/lib/waiver-document";
import { missingRequiredAcks, resolveAcknowledgements } from "@/lib/waiver-acknowledgements";
import { anyHealthConcern, healthQuestions, missingHealthAnswers } from "@/lib/waiver-health";
import { useAuth } from "@/hooks/useAuth";
import {
  resolveNamePrefill,
  waiverPrefillSearchSchema,
  type HealthAnswers,
  type HealthQuestionId,
} from "@/lib/validation";

export const Route = createFileRoute("/waiver")({
  // Optional prefill carried over from Step 1 of the "Start your free trial" flow.
  validateSearch: waiverPrefillSearchSchema,
  head: () => ({
    meta: [
      { title: "Sign waiver | UTS Jitsu" },
      {
        name: "description",
        content: "Complete the UTS Jitsu training waiver before your first class.",
      },
      { property: "og:title", content: "Sign waiver | UTS Jitsu" },
      { property: "og:description", content: "Complete the UTS Jitsu training waiver online." },
      { property: "og:url", content: "https://jitsu.au/waiver" },
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

  const [loading, setLoading] = useState(false);
  // Accepted acknowledgements keyed by the template's acknowledgement id.
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

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
  }, [authLoading, user, fetchMine]);

  // A signed-in person signs for their own account: the waiver's email is
  // their login email, and the field is locked (the server enforces the match).
  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user]);

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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (missingHealthAnswers(health).length > 0) {
      toast.error("Please answer yes or no to every health question.");
      return;
    }
    if (anyHealthConcern(health) && !medical.trim()) {
      toast.error("Please give details of anything you answered yes to.");
      return;
    }
    if (missingRequiredAcks(ackDefs, acks).length > 0) {
      toast.error("Please read and accept the required acknowledgements.");
      return;
    }
    const sigImg = signatureMode === "draw" ? signatureImage : "";
    const sigName = signatureMode === "type" ? signatureName : "";
    if (!sigImg && !sigName.trim()) {
      toast.error("Please add your signature by drawing it or typing your name.");
      return;
    }
    if (isMinor) {
      const gImg = guardianSignatureMode === "draw" ? guardianSignatureImage : "";
      const gName = guardianSignatureMode === "type" ? guardianSignature : "";
      if (!gImg && !gName.trim()) {
        toast.error("A parent or guardian must sign for participants under 18.");
        return;
      }
    }
    setLoading(true);
    try {
      const res = await submit({
        data: {
          first_name: firstName,
          middle_name: middleName,
          last_name: lastName,
          preferred_name: preferredName,
          date_of_birth: dob,
          address,
          phone,
          email,
          uts_student_number: utsStudentNumber,
          sms_whatsapp_consent: smsConsent,
          emergency_contact_name: ecName,
          emergency_contact_relationship: ecRelationship,
          emergency_contact_phone: ecPhone,
          // Every question is answered by this point (guarded above), so the
          // draft narrows to the five booleans the server requires.
          health_answers: health as HealthAnswers,
          medical_notes: medical,
          acknowledgements: acks,
          signature_name: sigName,
          signature_image: sigImg,
          is_minor: isMinor,
          guardian_signature: guardianSignatureMode === "type" ? guardianSignature : "",
          guardian_signature_image: guardianSignatureMode === "draw" ? guardianSignatureImage : "",
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
      if (res.pdf_url) setPdfUrl(res.pdf_url);
      toast.success("Waiver signed. Download your copy below.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (pdfUrl) {
    return (
      <SiteLayout>
        <section className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
          <CheckCircle2 className="h-16 w-16 text-primary" />
          <h1 className="mt-6 text-3xl font-bold md:text-4xl">Waiver signed</h1>
          <p className="mt-3 text-muted-foreground">
            Thanks. A copy has been saved. Download your signed waiver PDF below.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <a href={pdfUrl} target="_blank" rel="noopener" download>
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
        </section>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Waiver</p>
        <h1 className="mt-3 text-4xl font-bold">Training waiver</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Please complete the waiver before your first training session. Your details are kept
          private and used only for club administration.
        </p>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <form onSubmit={onSubmit} className="space-y-6 rounded-2xl border bg-card p-6 md:p-8">
            <input type="hidden" name="hp" value="" />

            {user && (
              <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
                Signed in as {user.email}. Your details have been pre-filled from your profile.
              </p>
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
                    className="mt-1.5"
                  />
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
                    className="mt-1.5"
                  />
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
                    className="mt-1.5"
                  />
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
                    className="mt-1.5"
                  />
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
                  className="mt-1.5"
                />
                {user && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    You're signed in, so the waiver uses your account email. To sign for someone
                    else, log out first.
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
                  className="mt-1.5"
                />
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
                    className="mt-1.5"
                  />
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
                    className="mt-1.5"
                  />
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
                    className="mt-1.5"
                  />
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
                  className="mt-1.5"
                />
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
                  <label key={ack.id} className="flex items-start gap-3 text-sm">
                    <Checkbox
                      checked={acks[ack.id] === true}
                      onCheckedChange={(v) =>
                        setAcks((prev) => ({ ...prev, [ack.id]: v === true }))
                      }
                      className="mt-0.5"
                    />
                    <span>
                      {applyWaiverPlaceholders(ack.label, ackPlaceholders)}
                      {!ack.required && <span className="text-muted-foreground"> (optional)</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            <fieldset className="space-y-3 border-t pt-6">
              <legend className="text-sm font-semibold">Signature</legend>
              <Tabs
                value={signatureMode}
                onValueChange={(v) => setSignatureMode(v as "draw" | "type")}
              >
                <TabsList className="grid w-full max-w-xs grid-cols-2">
                  <TabsTrigger value="draw">Draw</TabsTrigger>
                  <TabsTrigger value="type">Type</TabsTrigger>
                </TabsList>
                <TabsContent value="draw" className="mt-3">
                  <SignaturePad
                    ref={sigPadRef}
                    onChange={setSignatureImage}
                    ariaLabel="Your signature"
                  />
                </TabsContent>
                <TabsContent value="type" className="mt-3">
                  <Label htmlFor="signature_name">Type your full name to sign</Label>
                  <Input
                    id="signature_name"
                    maxLength={120}
                    value={signatureName}
                    onChange={(e) => setSignatureName(e.target.value)}
                    placeholder="Your full name"
                    className="mt-1.5"
                  />
                </TabsContent>
              </Tabs>
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
                  <div>
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
                          ref={gSigPadRef}
                          onChange={setGuardianSignatureImage}
                          ariaLabel="Guardian signature"
                        />
                      </TabsContent>
                      <TabsContent value="type" className="mt-3">
                        <Input
                          maxLength={120}
                          value={guardianSignature}
                          onChange={(e) => setGuardianSignature(e.target.value)}
                          placeholder="Guardian full name"
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                </div>
              )}
            </fieldset>

            <Button type="submit" size="lg" disabled={loading} className="w-full">
              {loading ? "Generating PDF..." : "Sign and download waiver"}
            </Button>
          </form>

          <aside className="lg:sticky lg:top-24 lg:self-start">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Live preview</p>
              <p className="text-xs text-muted-foreground">Updates as you type</p>
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
          </aside>
        </div>
      </section>
    </SiteLayout>
  );
}
