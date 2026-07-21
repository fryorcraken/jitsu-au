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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckCircle2, Download } from "lucide-react";
import { SignaturePad, type SignaturePadHandle } from "@/components/site/SignaturePad";
import { WaiverDocument } from "@/components/site/WaiverDocument";
import {
  submitWaiverWithPdf,
  getCurrentWaiverTemplate,
  getMyLatestWaiver,
} from "@/lib/waiver.functions";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/waiver")({
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

type Prefill = {
  full_name?: string;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string;
  address?: string;
  phone?: string;
  email?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  medical_notes?: string;
};

function splitLegacyName(full: string): { first: string; middle: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", middle: "", last: "" };
  if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
  if (parts.length === 2) return { first: parts[0], middle: "", last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
}

function Waiver() {
  const submit = useServerFn(submitWaiverWithPdf);
  const fetchTemplate = useServerFn(getCurrentWaiverTemplate);
  const fetchMine = useServerFn(getMyLatestWaiver);
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(false);
  const [ackRisk, setAckRisk] = useState(false);
  const [ackRelease, setAckRelease] = useState(false);
  const [ackMedia, setAckMedia] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  // Controlled form fields so we can render a live PDF preview
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [medical, setMedical] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [signatureImage, setSignatureImage] = useState("");
  const [signatureMode, setSignatureMode] = useState<"draw" | "type">("draw");
  const [guardianName, setGuardianName] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");
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
        } else if (r.full_name) {
          const s = splitLegacyName(r.full_name);
          setFirstName(s.first);
          setMiddleName(s.middle);
          setLastName(s.last);
        }
        if (r.date_of_birth) setDob(r.date_of_birth);
        if (r.phone) setPhone(r.phone);
        if (r.email) setEmail(r.email);
        if (r.address) setAddress(r.address);
        if (r.emergency_contact_name) setEcName(r.emergency_contact_name);
        if (r.emergency_contact_phone) setEcPhone(r.emergency_contact_phone);
        if (r.medical_notes) setMedical(r.medical_notes);
      })
      .catch(() => {
        /* no prior waiver */
      });
  }, [authLoading, user, fetchMine]);

  useEffect(() => {
    if (user?.email && !email) setEmail(user.email);
  }, [user, email]);

  // ---- Live preview (HTML rendering of the waiver, mirrors the PDF) ----
  const previewSignatureImage = signatureMode === "draw" ? signatureImage : "";
  const previewGuardianSignatureImage =
    guardianSignatureMode === "draw" ? guardianSignatureImage : "";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ackRisk || !ackRelease) {
      toast.error("Please read and accept the required acknowledgements.");
      return;
    }
    const sigImg = signatureMode === "draw" ? signatureImage : "";
    const sigName = signatureMode === "type" ? signatureName : "";
    if (!sigImg && !sigName.trim()) {
      toast.error("Please add your signature — draw it or type your name.");
      return;
    }
    if (isMinor) {
      const gImg = guardianSignatureMode === "draw" ? guardianSignatureImage : "";
      const gName = guardianSignatureMode === "type" ? guardianSignature : "";
      if (!guardianName.trim() || !guardianRelationship.trim() || (!gImg && !gName.trim())) {
        toast.error(
          "Parent/guardian name, relationship and signature are required for participants under 18.",
        );
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
          date_of_birth: dob,
          address,
          phone,
          email,
          emergency_contact_name: ecName,
          emergency_contact_phone: ecPhone,
          medical_notes: medical,
          ack_risk: true,
          ack_release: true,
          ack_media: ackMedia,
          signature_name: sigName,
          signature_image: sigImg,
          is_minor: isMinor,
          guardian_name: guardianName,
          guardian_relationship: guardianRelationship,
          guardian_signature: guardianSignatureMode === "type" ? guardianSignature : "",
          guardian_signature_image: guardianSignatureMode === "draw" ? guardianSignatureImage : "",
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
                Signed in as {user.email}. Your details have been pre-filled from your last waiver.
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
                  className="mt-1.5"
                />
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
            </fieldset>

            <fieldset className="space-y-5 border-t pt-6">
              <legend className="text-sm font-semibold">Emergency contact</legend>
              <div className="grid gap-5 sm:grid-cols-2">
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
                  <Label htmlFor="emergency_contact_phone">Contact phone</Label>
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

            <fieldset className="space-y-3 border-t pt-6">
              <legend className="text-sm font-semibold">Medical</legend>
              <Label htmlFor="medical_notes">
                Any injuries, conditions or medications we should know about? (optional)
              </Label>
              <Textarea
                id="medical_notes"
                maxLength={2000}
                rows={4}
                value={medical}
                onChange={(e) => setMedical(e.target.value)}
              />
            </fieldset>

            <fieldset className="space-y-4 border-t pt-6">
              <legend className="text-sm font-semibold">Acknowledgements</legend>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={ackRisk}
                  onCheckedChange={(v) => setAckRisk(v === true)}
                  className="mt-0.5"
                />
                <span>
                  I understand that Japanese Jiu-Jitsu involves physical contact and risk of injury,
                  and I participate voluntarily at my own risk.
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={ackRelease}
                  onCheckedChange={(v) => setAckRelease(v === true)}
                  className="mt-0.5"
                />
                <span>
                  I release Sydney Jitsu Inc, UTS Jitsu, its instructors and training partners from
                  liability for injuries sustained during training, except where caused by gross
                  negligence.
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={ackMedia}
                  onCheckedChange={(v) => setAckMedia(v === true)}
                  className="mt-0.5"
                />
                <span>
                  (Optional) I consent to photos and video taken during class being used for club
                  promotion on social media and the club website.
                </span>
              </label>
            </fieldset>

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
                    Participant is under 18. A parent or legal guardian must also sign.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="guardian_name">Parent/guardian full name</Label>
                      <Input
                        id="guardian_name"
                        required
                        maxLength={120}
                        value={guardianName}
                        onChange={(e) => setGuardianName(e.target.value)}
                        className="mt-1.5"
                      />
                    </div>
                    <div>
                      <Label htmlFor="guardian_relationship">Relationship</Label>
                      <Input
                        id="guardian_relationship"
                        required
                        maxLength={80}
                        value={guardianRelationship}
                        onChange={(e) => setGuardianRelationship(e.target.value)}
                        placeholder="Parent, guardian, etc."
                        className="mt-1.5"
                      />
                    </div>
                  </div>
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
                fullName={fullName}
                dateOfBirth={dob}
                address={address}
                phone={phone}
                email={email}
                emergencyContactName={ecName}
                emergencyContactPhone={ecPhone}
                medicalNotes={medical}
                ackRisk={ackRisk}
                ackRelease={ackRelease}
                ackMedia={ackMedia}
                signatureName={signatureMode === "type" ? signatureName : ""}
                signatureImage={previewSignatureImage}
                isMinor={isMinor}
                guardianName={guardianName}
                guardianRelationship={guardianRelationship}
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
