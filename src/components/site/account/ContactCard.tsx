import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import { SaveFailure } from "@/components/site/SaveFailure";
import { CardActions } from "./CardActions";
import { useDetailsSave, type DetailsCardProps } from "./DetailsCard";

/**
 * How the club reaches this person, and who it calls if something happens.
 *
 * The warning in the description is not boilerplate: approving a waiver still
 * promotes that submission's contact fields onto the profile
 * (`waiverToProfileFields`), so a correction made here can be overwritten later
 * by a manager working through a backlog of older waivers.
 */
export function ContactCard({ userId, voice, profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save, saveError, clearSaveError, retrySave } = useDetailsSave({
    userId,
    profile,
    onSaved,
  });
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(
    () => ({
      phone: profile?.phone ?? "",
      address: profile?.address ?? "",
      smsConsent: profile?.sms_whatsapp_consent ?? false,
      ecName: profile?.emergency_contact_name ?? "",
      ecRelationship: profile?.emergency_contact_relationship ?? "",
      ecPhone: profile?.emergency_contact_phone ?? "",
    }),
    [
      profile?.phone,
      profile?.address,
      profile?.sms_whatsapp_consent,
      profile?.emergency_contact_name,
      profile?.emergency_contact_relationship,
      profile?.emergency_contact_phone,
    ],
  );

  const revert = useMemo(
    () => () => {
      setPhone(stored.phone);
      setAddress(stored.address);
      setSmsConsent(stored.smsConsent);
      setEcName(stored.ecName);
      setEcRelationship(stored.ecRelationship);
      setEcPhone(stored.ecPhone);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty =
    phone !== stored.phone ||
    address !== stored.address ||
    smsConsent !== stored.smsConsent ||
    ecName !== stored.ecName ||
    ecRelationship !== stored.ecRelationship ||
    ecPhone !== stored.ecPhone;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save(
      {
        phone: phone.trim(),
        address: address.trim(),
        sms_whatsapp_consent: smsConsent,
        emergency_contact_name: ecName.trim(),
        emergency_contact_relationship: ecRelationship.trim(),
        emergency_contact_phone: ecPhone.trim(),
      },
      "Contact details saved",
      `Could not save ${voice.whose} contact details`,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact</CardTitle>
        <CardDescription>
          How we reach {voice.who}, and who we call if something happens in class. Saving here
          updates our current record straight away. It does not change a waiver already signed,
          which keeps what was typed at the time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="account-phone">Mobile</Label>
              <Input
                id="account-phone"
                type="tel"
                required
                maxLength={30}
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearSaveError();
                }}
                className="mt-1.5"
              />
              <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={smsConsent}
                  onCheckedChange={(v) => {
                    setSmsConsent(v === true);
                    clearSaveError();
                  }}
                  className="mt-0.5"
                  aria-label="Consent to SMS or WhatsApp contact"
                />
                <span>
                  {voice.isSelf
                    ? "I agree to be contacted by SMS or WhatsApp, and added to club WhatsApp groups."
                    : `We agree to ${voice.who} being contacted by SMS or WhatsApp, and added to club WhatsApp groups.`}
                </span>
              </label>
            </div>
            <div>
              <Label htmlFor="account-address">Address</Label>
              <Input
                id="account-address"
                required
                maxLength={300}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  clearSaveError();
                }}
                className="mt-1.5"
              />
            </div>

            <fieldset className="space-y-4 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">Emergency contact</legend>
              <div>
                <Label htmlFor="account-ec-name">Name</Label>
                <Input
                  id="account-ec-name"
                  required
                  maxLength={120}
                  value={ecName}
                  onChange={(e) => {
                    setEcName(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-relationship">Relationship</Label>
                <Input
                  id="account-ec-relationship"
                  required
                  maxLength={80}
                  value={ecRelationship}
                  onChange={(e) => {
                    setEcRelationship(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-phone">Mobile</Label>
                <Input
                  id="account-ec-phone"
                  type="tel"
                  required
                  maxLength={30}
                  value={ecPhone}
                  onChange={(e) => {
                    setEcPhone(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
            </fieldset>

            {saveError && (
              <SaveFailure
                what={`${voice.Whose} contact details`}
                message={saveError}
                onRetry={() => void retrySave?.()}
                retrying={busy}
              />
            )}
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
