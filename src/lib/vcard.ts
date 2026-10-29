// A person's contact card, as a vCard file a manager's phone can import.
//
// Pure and side-effect free, like `ics.ts`, whose escaping and line folding it
// reuses: vCard 3.0 (RFC 2426) and iCalendar both sit on the same RFC 2425
// content-line syntax, so the two rules are the same rules.
//
// Why 3.0 and nothing newer. Android's Contacts importer reads 2.1 and 3.0
// properly and 4.0 only in part (it drops what it does not know), and iOS,
// Google Contacts and Outlook all read 3.0. So 3.0 is the one version every
// phone a manager is likely to hold opens without losing a field.
//
// The labelled numbers ("Guardian", "Emergency") use the `X-<label>` TYPE that
// Android imports as a custom label. Anything that does not know it still keeps
// the number; it only loses the word beside it.
//
// ⚠️ What is NOT on the card is a decision, not an oversight. A contact card
// leaves the club's systems the moment it is saved: it syncs to the manager's
// own Google or iCloud account and goes wherever their phone backs up to. So it
// carries how to reach somebody and nothing else. Medical notes, consents, the
// student number and kit sizes stay on the person page.

import { escapeIcsText, foldIcsLine } from "@/lib/ics";
import { profileFullName } from "@/lib/validation";

export type VCardPerson = {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  /** The address the club writes to about them. For a dependant it is their guardian's. */
  email: string | null;
  /** Set when `email` is somebody else's: a dependant's account holder. */
  email_belongs_to: string | null;
  phone: string | null;
  address: string | null;
  /** `YYYY-MM-DD`, as Postgres returns a `date`. */
  date_of_birth: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  is_minor: boolean;
  guardian_name: string | null;
  guardian_relationship: string | null;
  guardian_phone: string | null;
  guardian_email: string | null;
  /** Link back to their record, so the card opens the person page. */
  url?: string;
};

/** Trimmed, or null when there is nothing left. */
function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** "Bea (Sister)", "Bea", "(Sister)" or null. */
function nameWithRelationship(name: string | null, relationship: string | null): string | null {
  const n = clean(name);
  const r = clean(relationship);
  if (n && r) return `${n} (${r})`;
  return n ?? (r ? `(${r})` : null);
}

/**
 * A TYPE label Android shows beside a number. Parameter values may not carry
 * `;`, `:`, `,` or a double quote (RFC 2425 §5.8.2), so anything outside
 * letters, digits, spaces and hyphens is dropped rather than escaped.
 */
function customType(label: string): string {
  return `X-${label.replace(/[^A-Za-z0-9 -]/g, "").trim()}`;
}

/** Build the card. Lines are CRLF-separated and folded, ending in a CRLF. */
export function buildVCard(p: VCardPerson): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  const add = (line: string) => lines.push(foldIcsLine(line));
  const text = (value: string) => escapeIcsText(value);

  const first = clean(p.first_name) ?? "";
  const middle = clean(p.middle_name) ?? "";
  const last = clean(p.last_name) ?? "";
  // N is required in 3.0, and it is what Android files the contact under.
  add(`N:${text(last)};${text(first)};${text(middle)};;`);
  add(`FN:${text(profileFullName(p) || "UTS Jitsu member")}`);
  const preferred = clean(p.preferred_name);
  if (preferred && preferred.toLowerCase() !== first.toLowerCase()) {
    add(`NICKNAME:${text(preferred)}`);
  }

  const phone = clean(p.phone);
  if (phone) add(`TEL;TYPE=CELL:${text(phone)}`);

  // Each email at most once: a minor's guardian email is usually the same
  // address their account is held under.
  const emails = new Set<string>();
  const addEmail = (address: string | null, label: string | null) => {
    const value = clean(address);
    if (!value || emails.has(value.toLowerCase())) return;
    emails.add(value.toLowerCase());
    // No INTERNET type: it is 3.0's default anyway, and Android turns a type
    // it has no slot for into the label, so it could show up as "INTERNET".
    add(`EMAIL;TYPE=${label ? customType(label) : "HOME"}:${text(value)}`);
  };
  // A dependant has no mailbox of their own. The one on file is the account
  // holder's, so it is labelled as theirs rather than passed off as the child's.
  addEmail(p.email, clean(p.email_belongs_to) ? "Guardian" : null);

  const address = clean(p.address);
  // The club keeps an address as one line of free text, so it all goes in the
  // street component; Android shows the components joined back up.
  if (address) add(`ADR;TYPE=HOME:;;${text(address)};;;;`);

  if (p.date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(p.date_of_birth)) {
    add(`BDAY:${p.date_of_birth}`);
  }

  const notes: string[] = ["UTS Jitsu"];
  if (p.is_minor) {
    const guardianPhone = clean(p.guardian_phone);
    if (guardianPhone) add(`TEL;TYPE=${customType("Guardian")}:${text(guardianPhone)}`);
    addEmail(p.guardian_email, "Guardian");
    const guardian = nameWithRelationship(p.guardian_name, p.guardian_relationship);
    if (guardian) notes.push(`Guardian: ${guardian}`);
  }
  const emergencyPhone = clean(p.emergency_contact_phone);
  if (emergencyPhone) add(`TEL;TYPE=${customType("Emergency")}:${text(emergencyPhone)}`);
  const emergency = nameWithRelationship(
    p.emergency_contact_name,
    p.emergency_contact_relationship,
  );
  if (emergency) notes.push(`Emergency contact: ${emergency}`);

  add(`NOTE:${text(notes.join("\n"))}`);
  if (p.url) add(`URL:${p.url}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

/** A file name a phone and a desktop both accept: the person's name, `.vcf`. */
export function vCardFileName(p: Pick<VCardPerson, "first_name" | "middle_name" | "last_name">) {
  const name = profileFullName(p)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || "contact"}.vcf`;
}
