import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import { AddressFields } from "@/components/site/AddressFields";
import {
  auAddressDraft,
  auAddressFromRow,
  completeAuAddress,
  composeAuAddress,
  splitAuAddress,
  type AuAddressDraft,
} from "@/lib/au-address";
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
  const [address, setAddress] = useState<AuAddressDraft>(auAddressDraft(null));
  // Pressing Save with part of the address missing is the one way this card
  // can be refused before it is sent, so it says which part, under the field.
  const [attempted, setAttempted] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(
    () => ({
      phone: profile?.phone ?? "",
      // The parts when the club holds them, else the one line read as parts
      // where that is unambiguous. `addressLine` is kept so a line that
      // cannot be read is shown above the empty boxes rather than lost.
      address: auAddressDraft(
        auAddressFromRow({
          address_street: profile?.address_street,
          address_suburb: profile?.address_suburb,
          address_state: profile?.address_state,
          address_postcode: profile?.address_postcode,
        }) ?? splitAuAddress(profile?.address),
      ),
      addressLine: profile?.address ?? "",
      smsConsent: profile?.sms_whatsapp_consent ?? false,
      ecName: profile?.emergency_contact_name ?? "",
      ecRelationship: profile?.emergency_contact_relationship ?? "",
      ecPhone: profile?.emergency_contact_phone ?? "",
    }),
    [
      profile?.phone,
      profile?.address,
      profile?.address_street,
      profile?.address_suburb,
      profile?.address_state,
      profile?.address_postcode,
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
      setAttempted(false);
      setSmsConsent(stored.smsConsent);
      setEcName(stored.ecName);
      setEcRelationship(stored.ecRelationship);
      setEcPhone(stored.ecPhone);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const addressChanged = (["street", "suburb", "state", "postcode"] as const).some(
    (part) => address[part] !== stored.address[part],
  );
  const dirty =
    phone !== stored.phone ||
    addressChanged ||
    smsConsent !== stored.smsConsent ||
    ecName !== stored.ecName ||
    ecRelationship !== stored.ecRelationship ||
    ecPhone !== stored.ecPhone;

  // The line on file could not be read as parts and nothing has been typed
  // over it yet: show it, so the member can see what they told us.
  const previousLine =
    !addressChanged && !completeAuAddress(stored.address) && stored.addressLine
      ? stored.addressLine
      : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parts = completeAuAddress(address);
    if (!parts) {
      setAttempted(true);
      return;
    }
    await save(
      {
        phone: phone.trim(),
        // The parts, plus the line made from them so this page's copy of the
        // profile reads right straight away. The server composes the line
        // itself and does not take this one on trust.
        address_street: parts.street,
        address_suburb: parts.suburb,
        address_state: parts.state,
        address_postcode: parts.postcode,
        address: composeAuAddress(parts),
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
          {voice.isSelf
            ? "How we reach you, and who we call if something happens in class."
            : `How we reach you about ${voice.who}, and who we call if something happens in class.`}{" "}
          Saving here updates our current record straight away. It does not change a waiver already
          signed, which keeps what was typed at the time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="account-phone">Mobile{voice.isSelf ? "" : " to reach you on"}</Label>
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
                />
                <span>
                  {/* "I", not "we": everywhere else on this card "we" is the
                      club, so "we agree" read as the club agreeing with itself.
                      The person ticking is one parent. */}
                  {voice.isSelf
                    ? "I agree to be contacted by SMS or WhatsApp, and added to club WhatsApp groups."
                    : `I agree to ${voice.who} being contacted by SMS or WhatsApp, and added to club WhatsApp groups.`}
                </span>
              </label>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Home address</legend>
              <AddressFields
                idPrefix="account-address"
                value={address}
                onChange={(next) => {
                  setAddress(next);
                  clearSaveError();
                }}
                previousLine={previousLine}
                showProblems={attempted}
              />
            </fieldset>

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
                what="change to the contact details"
                message={saveError}
                onRetry={() => void retrySave?.()}
                retrying={busy}
                keptOnDevice={false}
              />
            )}
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
