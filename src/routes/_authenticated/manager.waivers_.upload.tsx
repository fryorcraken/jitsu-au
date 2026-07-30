import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FileText, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_SCAN_BYTES, isMinorOn, scanMimeTypes } from "@/lib/validation";
import { getCurrentWaiverTemplate, uploadPaperWaiver } from "@/lib/waiver.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/waivers_/upload")({
  head: () => ({
    meta: [{ title: "Upload a paper waiver | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: UploadPaperWaiverPage,
});

const ACCEPT = scanMimeTypes.join(",");

/** Today's date in the browser's own timezone, as the `YYYY-MM-DD` a date input wants. */
function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Base64 for the request body, chunked.
 *
 * `String.fromCharCode(...bytes)` on a whole multi-megabyte scan blows the call
 * stack, so the bytes go across in 32 KB slices.
 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

function UploadPaperWaiverPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchTemplate = useServerFn(getCurrentWaiverTemplate);
  const upload = useServerFn(uploadPaperWaiver);
  const fileInput = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);

  const [signedOn, setSignedOn] = useState(todayLocal());
  const [templateVersion, setTemplateVersion] = useState("");

  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [lastName, setLastName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [studentNumber, setStudentNumber] = useState("");

  const [contactName, setContactName] = useState("");
  const [contactRelationship, setContactRelationship] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [medicalNotes, setMedicalNotes] = useState("");

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  // Default the version to whatever the site is currently serving: most paper
  // forms handed out are printed from it. A manager can clear or change it.
  useEffect(() => {
    if (!isManager) return;
    fetchTemplate()
      .then((tpl) => {
        if (tpl) setTemplateVersion(String(tpl.version));
      })
      .catch(() => {});
  }, [isManager, fetchTemplate]);

  const totalBytes = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);
  const tooLarge = totalBytes > MAX_SCAN_BYTES;
  const isMinor = Boolean(dob && signedOn && isMinorOn(dob, signedOn));

  function addFiles(picked: FileList | null) {
    if (!picked?.length) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(picked)) {
      if ((scanMimeTypes as readonly string[]).includes(file.type)) accepted.push(file);
      else rejected.push(file.name);
    }
    if (rejected.length) {
      toast.error(`Not a PDF or a photo: ${rejected.join(", ")}`);
    }
    setFiles((prev) => [...prev, ...accepted].slice(0, 20));
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) {
      toast.error("Attach the scanned form first.");
      return;
    }
    if (tooLarge) {
      toast.error("The scan is too large. Keep the whole upload under 10 MB.");
      return;
    }
    setSaving(true);
    try {
      const scan = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type as (typeof scanMimeTypes)[number],
          data: await fileToBase64(file),
        })),
      );
      const res = await upload({
        data: {
          first_name: firstName,
          middle_name: middleName,
          last_name: lastName,
          preferred_name: preferredName,
          date_of_birth: dob,
          address,
          phone,
          email,
          uts_student_number: studentNumber,
          sms_whatsapp_consent: smsConsent,
          emergency_contact_name: contactName,
          emergency_contact_relationship: contactRelationship,
          emergency_contact_phone: contactPhone,
          medical_notes: medicalNotes,
          signed_on: signedOn,
          template_version: templateVersion.trim() ? Number(templateVersion) : null,
          scan,
        },
      });
      toast.success("Waiver filed. It is pending until you approve it.");
      navigate({ to: "/manager/users/$userId", params: { userId: res.user_id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not file the waiver");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Upload a paper waiver</h1>
          <p className="text-sm text-muted-foreground">
            For a form somebody filled in on paper. The scan becomes the signed document, so the
            signature, the ticks and the health answers stay on it and are not retyped here.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/manager/waivers">Back to waivers</Link>
        </Button>
      </div>

      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        Nothing is emailed when you file this, and it lands as pending. Approving it is the step
        that updates the person's record, sets up their login and starts their free trial, exactly
        as it does for a waiver signed on the site.
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <Section title="The scan">
          <div>
            <input
              ref={fileInput}
              id="scan"
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              onChange={(e) => addFiles(e.target.files)}
            />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload className="mr-2 h-4 w-4" /> Choose files
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              A PDF, or a photo of each page (PNG or JPEG). Several files are joined into one
              document in the order below. Up to 10 MB in total.
            </p>
          </div>

          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => removeFile(i)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {files.length > 0 && (
            <p className={tooLarge ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>
              {files.length} file{files.length === 1 ? "" : "s"}, {formatBytes(totalBytes)} in total
              {tooLarge ? ". That is over the 10 MB limit." : "."}
            </p>
          )}
        </Section>

        <Section title="The form">
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="signed_on">Date signed</Label>
              <Input
                id="signed_on"
                type="date"
                required
                max={todayLocal()}
                value={signedOn}
                onChange={(e) => setSignedOn(e.target.value)}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                The date written on the paper, not today. It is what the club's records show as when
                they signed. Filing an old form is fine, but be aware that approving it makes it
                their active waiver whatever its date, because active means most recently approved.
              </p>
            </div>
            <div>
              <Label htmlFor="template_version">
                Form version <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="template_version"
                type="number"
                min={1}
                step={1}
                value={templateVersion}
                onChange={(e) => setTemplateVersion(e.target.value)}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Which version of the form the paper is. Leave it blank for an older form you cannot
                place.
              </p>
            </div>
          </div>
        </Section>

        <Section title="Applicant">
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
              className="mt-1.5"
            />
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
              <p className="mt-1.5 text-xs text-muted-foreground">
                {!dob
                  ? "This decides whether the form was signed by the applicant or by a guardian."
                  : isMinor
                    ? "Under 18 on the date signed, so the emergency contact below is the guardian who signed."
                    : "18 or over on the date signed, so they signed as the applicant."}
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
                <span>They ticked consent to SMS or WhatsApp contact on the form.</span>
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
              className="mt-1.5"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              This is who the waiver belongs to. An address the club already knows attaches to that
              person, a new one creates them. Check it against the paper carefully: a typo makes a
              second person.
            </p>
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
              value={studentNumber}
              onChange={(e) => setStudentNumber(e.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Filling this in is what unlocks the student rate for them.
            </p>
          </div>
        </Section>

        <Section title={isMinor ? "Parent or guardian" : "Emergency contact"}>
          <div className="grid gap-5 sm:grid-cols-3">
            <div>
              <Label htmlFor="contact_name">Name</Label>
              <Input
                id="contact_name"
                required
                maxLength={120}
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="contact_relationship">
                Relationship {!isMinor && <span className="text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id="contact_relationship"
                required={isMinor}
                maxLength={80}
                value={contactRelationship}
                onChange={(e) => setContactRelationship(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="contact_phone">Phone</Label>
              <Input
                id="contact_phone"
                type="tel"
                required
                maxLength={30}
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>
          {isMinor && (
            <p className="text-xs text-muted-foreground">
              The applicant was under 18 when this was signed, so this is the parent or guardian who
              signed for them, and their relationship is required.
            </p>
          )}
        </Section>

        <Section title="Health">
          <div>
            <Label htmlFor="medical_notes">
              Details of anything answered yes{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="medical_notes"
              rows={4}
              maxLength={2000}
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Copy across anything the instructors need to hand. The five yes or no answers
              themselves stay on the scan, the same way they live inside the PDF of a waiver signed
              on the site.
            </p>
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving || tooLarge}>
            {saving ? "Filing..." : "File this waiver"}
          </Button>
          <Button asChild type="button" variant="ghost">
            <Link to="/manager/waivers">Cancel</Link>
          </Button>
        </div>
      </form>
    </section>
  );
}
