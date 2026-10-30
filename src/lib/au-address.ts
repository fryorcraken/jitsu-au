// An Australian address in parts: street, suburb, state and postcode.
//
// Every address the club held used to be one free-text box, so nothing made
// anybody give a postcode and nothing could be sorted by suburb. The database
// now keeps the four parts beside the one-line `address` that every screen,
// email and PDF still reads (`20261029000000_structured_address.sql`), and this
// module is the app's half of that arrangement: the rules a part must satisfy,
// the one way to turn parts into a line, and the one way back.
//
// The line format is not a matter of taste. On `waivers` the database refuses
// a row whose `address` is not exactly the line composed from its parts
// (`waivers_address_matches_parts`), so a composition here that differed from
// the migration's by one space would stop every waiver from being signed.
// `au-address.test.ts` reads the migration and fails if the two ever disagree.
//
// An address outside Australia is the one exception, and it is deliberately
// simple: the same boxes plus a country, every one free text and only the
// street line required, stored as the one line made from them with no parts.
// It has no state list or postcode format to meet, so it cannot be sorted or
// counted by suburb or postcode, and it is not meant to be: the parts exist
// for the club's Australian addresses.
//
// Pure and server-import-free, like `validation.ts`, so the form, the server
// and the tests all share it.
import { z } from "zod";

/** The eight states and territories, by the abbreviation an address uses. */
export const AU_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export type AuState = (typeof AU_STATES)[number];

/** What the state picker shows. The abbreviation leads, as on an envelope. */
export const AU_STATE_NAMES: Record<AuState, string> = {
  ACT: "Australian Capital Territory",
  NSW: "New South Wales",
  NT: "Northern Territory",
  QLD: "Queensland",
  SA: "South Australia",
  TAS: "Tasmania",
  VIC: "Victoria",
  WA: "Western Australia",
};

export const isAuState = (value: string): value is AuState =>
  (AU_STATES as readonly string[]).includes(value);

/** A complete address. Every part is trimmed and present. */
export type AuAddress = {
  street: string;
  suburb: string;
  state: AuState;
  postcode: string;
};

/**
 * An address while somebody is typing it: any part may still be blank.
 *
 * `overseas` is the "This address is outside Australia" tick. While it is off,
 * `state` is one of `AU_STATES` (or "" for not chosen yet) and `country` is
 * unused; while it is on, every part is free text.
 */
export type AddressDraft = {
  /** Absent means Australian, which is what every draft was before the tick. */
  overseas?: boolean;
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  country?: string;
};

export const EMPTY_ADDRESS: AddressDraft = {
  overseas: false,
  street: "",
  suburb: "",
  state: "",
  postcode: "",
  country: "",
};

/** The longest each part may be, as the database's CHECK constraints allow. */
export const AU_ADDRESS_LIMITS = { street: 200, suburb: 60 } as const;

/**
 * The one-line form of an address: `<street>, <suburb> <STATE> <postcode>`.
 *
 * This is what lands in `address` and therefore on the signed PDF, so it must
 * match the migration's composition character for character.
 */
export function composeAuAddress(a: AuAddress): string {
  return `${a.street}, ${a.suburb} ${a.state} ${a.postcode}`;
}

/**
 * A control character, as the database's `[[:cntrl:]]` sees one in a UTF-8
 * locale: the C0 and C1 controls (`\p{Cc}`, tab and NEL included) and the
 * Unicode line and paragraph separators. Anything narrower here would let a
 * value through that the database's constraint then refuses mid-signing.
 */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

// Mirrors `public.split_au_address` in the migration, rule for rule, so the
// app and the database agree on which old addresses can be read as parts.
const SPLIT =
  /^\s*(.*[0-9].*[a-z.])\s*,\s*([^,0-9]*[^\s,0-9])\s*,?\s+(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s+([0-9]{4})(\s*,?\s*australia)?\s*$/i;
const POSTCODE_LEAD: Record<AuState, RegExp> = {
  ACT: /^(02|26|29)/,
  NSW: /^[12]/,
  NT: /^0[89]/,
  QLD: /^[49]/,
  SA: /^5/,
  TAS: /^7/,
  VIC: /^[38]/,
  WA: /^6/,
};

/**
 * Read the four parts out of a one-line address, or `null` when that cannot be
 * done without guessing. Used to offer an address the club holds as a single
 * line back to somebody as parts; the reasons it refuses are in the migration.
 */
export function splitAuAddress(line: string | null | undefined): AuAddress | null {
  // Any control character (a newline above all) means a multi-line address,
  // which is not the shape this reads.
  if (!line || CONTROL.test(line)) return null;
  const m = SPLIT.exec(line);
  if (!m) return null;
  const [, street, suburb, rawState, postcode] = m;
  if (street.length > AU_ADDRESS_LIMITS.street || suburb.length > AU_ADDRESS_LIMITS.suburb) {
    return null;
  }
  const state = rawState.toUpperCase() as AuState;
  if (!POSTCODE_LEAD[state].test(postcode)) return null;
  return { street, suburb, state, postcode };
}

/**
 * Read back a line this app composed itself (`composeAuAddress`), or `null`.
 *
 * The exact inverse of the composition, with none of `splitAuAddress`'s
 * guards, because there is nothing to guess: a line in exactly this shape was
 * made from parts somebody entered. That matters for the guardian's address,
 * which is stored as its composed line only. Read with `splitAuAddress`, a
 * street with no number ("Rose Cottage") or a border postcode (Barooga NSW
 * 3644) would come back as nothing, and the parent would retype it on every
 * waiver. Only for offering a line back to somebody to check, never for
 * deciding what gets stored.
 */
export function readComposedAuAddress(line: string | null | undefined): AuAddress | null {
  if (!line || CONTROL.test(line)) return null;
  const m = /^(.+), ([^,]+) (ACT|NSW|NT|QLD|SA|TAS|VIC|WA) ([0-9]{4})$/.exec(line);
  if (!m) return null;
  const parts = { street: m[1], suburb: m[2], state: m[3] as AuState, postcode: m[4] };
  // Only if it would be accepted as parts, so a line that merely looks right
  // (a digit in the "suburb") is not handed back as something it is not.
  return auAddressSchema.safeParse(parts).success ? parts : null;
}

/**
 * The draft to offer somebody for an address the club holds as one line, and
 * whether the line could be read at all (when it cannot, the form shows it
 * above empty boxes so it is not lost).
 *
 * Which reader is used depends on whose address it is, and the difference is
 * the whole point:
 *
 *   * `own`: a person's own address, whose parts are counted and reported.
 *     Only the careful split, never the composed read-back: a line somebody
 *     typed in the old single box ("Unit 3, Rose Avenue Glebe NSW 2037") fits
 *     the composed shape exactly while meaning something else, and reading it
 *     back would file "Rose Avenue Glebe" as their suburb.
 *   * `guardian`: a parent's address, which is stored only as its line and
 *     never as parts. The composed read-back is safe here, because whatever it
 *     reads composes back to exactly the line it was read from, so nothing
 *     stored can change; and it is needed, because the careful split refuses
 *     the "Rose Cottage" or Barooga NSW 3644 a parent entered last time.
 *
 * Either way, a line ending in a country other than Australia is read as an
 * address outside Australia, which is how one is recognised again next time:
 * the club stores no other marker of it.
 */
export function draftFromLine(
  line: string | null | undefined,
  whose: "own" | "guardian",
): { draft: AddressDraft; read: boolean } {
  const parts =
    whose === "guardian"
      ? (readComposedAuAddress(line) ?? splitAuAddress(line))
      : splitAuAddress(line);
  if (parts) return { draft: auAddressDraft(parts), read: true };
  const abroad = readOverseasLine(line);
  if (abroad) return { draft: abroad, read: true };
  return { draft: auAddressDraft(null), read: !line?.trim() };
}

/**
 * Every country name a line might end in, lower-cased, Australia left out.
 *
 * Built from the platform's own region names (`Intl.DisplayNames`) rather
 * than a list kept here, plus the handful of everyday names it does not give.
 * Built once, on first use. Where the platform has no region names, nothing is
 * recognised and an address abroad is simply asked about again.
 */
let countryNames: Set<string> | null = null;
function knownCountries(): Set<string> {
  if (countryNames) return countryNames;
  const names = new Set<string>(["uk", "usa", "us", "england", "scotland", "wales"]);
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const a of letters) {
      for (const b of letters) {
        const code = a + b;
        if (code === "AU") continue;
        const name = display.of(code);
        if (name) names.add(name.toLowerCase());
      }
    }
  } catch {
    // No region names here: recognise only the everyday ones above.
  }
  countryNames = names;
  return names;
}

/**
 * Read a line as an address outside Australia when it ends in a country the
 * platform knows, or `null`. Everything before the last comma goes in the
 * street box and the country in its own, which composes back to the same line.
 */
export function readOverseasLine(line: string | null | undefined): AddressDraft | null {
  if (!line || CONTROL.test(line)) return null;
  const cut = line.lastIndexOf(",");
  if (cut <= 0) return null;
  const rest = line.slice(0, cut).trim();
  const country = line.slice(cut + 1).trim();
  if (!rest || !knownCountries().has(country.toLowerCase())) return null;
  return { overseas: true, street: rest, suburb: "", state: "", postcode: "", country };
}

/** The draft to show for an address the club holds, or an empty one. */
export function auAddressDraft(a: AuAddress | null): AddressDraft {
  return a ? { ...EMPTY_ADDRESS, ...a } : { ...EMPTY_ADDRESS };
}

/** Just the four Australian parts of a draft, for the strict schema. */
const auPartsOf = (d: AddressDraft) => ({
  street: d.street,
  suburb: d.suburb,
  state: d.state,
  postcode: d.postcode,
});

/** The address a profile or waiver row holds as parts, when it holds them. */
export function auAddressFromRow(row: {
  address_street?: string | null;
  address_suburb?: string | null;
  address_state?: string | null;
  address_postcode?: string | null;
}): AuAddress | null {
  const { address_street, address_suburb, address_state, address_postcode } = row;
  if (!address_street || !address_suburb || !address_postcode) return null;
  if (!address_state || !isAuState(address_state)) return null;
  return {
    street: address_street,
    suburb: address_suburb,
    state: address_state,
    postcode: address_postcode,
  };
}

/** The four columns an address is stored in, for an insert or an update. */
export function auAddressColumns(a: AuAddress | null) {
  return {
    address_street: a?.street ?? null,
    address_suburb: a?.suburb ?? null,
    address_state: a?.state ?? null,
    address_postcode: a?.postcode ?? null,
  };
}

/** What each part is called on the form, and therefore in a problem list. */
export const AU_ADDRESS_LABELS = {
  street: "Street address",
  suburb: "Suburb",
  state: "State",
  postcode: "Postcode",
} as const;

/** The same boxes' names for an address outside Australia. */
export const OVERSEAS_ADDRESS_LABELS = {
  street: "Street address",
  suburb: "Town or city",
  state: "State or region",
  postcode: "Postcode",
  country: "Country",
} as const;

/** The longest each part of an address outside Australia may be. */
export const OVERSEAS_ADDRESS_LIMITS = {
  // The whole line's limit, so a line the club already holds always fits when
  // it is moved into this box. The line as a whole is checked against the
  // same 300 below.
  street: 300,
  suburb: 60,
  state: 40,
  postcode: 12,
  country: 40,
} as const;

/** The four parts of an Australian address. */
export type AuAddressPart = keyof AuAddress;
/** Which part a problem is about. Doubles as the suffix of that input's id. */
export type AddressPart = AuAddressPart | "country";

/** The `id` of one part's input on a form: the form's jump links aim at these. */
export const auAddressFieldId = (idPrefix: string, part: AddressPart) => `${idPrefix}_${part}`;

/** One thing wrong with a draft, in the words the form shows under the field. */
export type AuAddressProblem = { part: AddressPart; label: string; hint?: string };

/**
 * What is still missing or wrong in a draft, in the order the fields appear.
 *
 * The same rules `auAddressSchema` enforces, said to a person: the form lists
 * these before anything is sent, so somebody hears "the postcode is four
 * digits" under the field rather than as a rejected submission.
 */
export function auAddressProblems(d: AddressDraft): AuAddressProblem[] {
  // Read off the schema itself rather than restated, so the form can never
  // pass an address the server then refuses (a pasted tab, say): what the
  // schema says about a part is what the person is told under it.
  const parsed = d.overseas
    ? overseasAddressSchema.safeParse(d)
    : auAddressSchema.safeParse(auPartsOf(d));
  if (parsed.success) return [];
  const labels: Record<AddressPart, string> = d.overseas
    ? OVERSEAS_ADDRESS_LABELS
    : { ...AU_ADDRESS_LABELS, country: OVERSEAS_ADDRESS_LABELS.country };
  const problems: AuAddressProblem[] = [];
  for (const part of ["street", "suburb", "state", "postcode", "country"] as const) {
    const issue = parsed.error.issues.find((i) => i.path[0] === part);
    if (!issue) continue;
    const blank = !String(d[part] ?? "").trim();
    problems.push({
      part,
      label: labels[part],
      // A blank part needs no explaining: "please fill this in" says it.
      ...(blank ? {} : { hint: issue.message.replace(/\.$/, "") }),
    });
  }
  // The whole line has a length too, which no one part owns: it is reported
  // against the street, the box most likely to be holding the bulk of it.
  const lineIssue = parsed.error.issues.find((i) => i.path.length === 0);
  if (lineIssue && !problems.some((p) => p.part === "street")) {
    problems.push({
      part: "street",
      label: labels.street,
      hint: lineIssue.message.replace(/\.$/, ""),
    });
  }
  return problems;
}

/**
 * A complete address as it crosses the wire. The same bounds as the database's
 * `*_address_parts_valid` constraints, so a submission is refused here in
 * words rather than by a constraint name after the insert.
 */
export const auAddressSchema = z
  .object({
    street: z
      .string()
      .trim()
      .min(1, "Please give the street address.")
      .max(AU_ADDRESS_LIMITS.street, "Please keep the street address under 200 characters.")
      .refine((v) => !CONTROL.test(v), "Please keep the street address on one line."),
    suburb: z
      .string()
      .trim()
      .min(1, "Please give the suburb.")
      .max(AU_ADDRESS_LIMITS.suburb, "Please keep the suburb under 60 characters.")
      // No digit and no comma: no suburb has either, and either would make the
      // composed line read back as a different address.
      .refine(
        (v) => !CONTROL.test(v) && !/[0-9,]/.test(v),
        "Just the suburb name here. The street goes in the line above.",
      ),
    // Upper-cased first, as the database stores it, so "nsw" from the agent API
    // is NSW rather than a refusal. The form's picker never sends anything
    // else, so this message is only ever read by a caller that typed one.
    state: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
      z.enum(AU_STATES, {
        message: "The state must be one of ACT, NSW, NT, QLD, SA, TAS, VIC or WA.",
      }),
    ),
    postcode: z
      .string()
      .trim()
      .regex(/^[0-9]{4}$/, "A postcode is four digits."),
  })
  // Strict, so a key nobody reads (a `unit`, a `country`) is refused rather
  // than silently dropped: dropping it would put a shorter address than the
  // one sent onto a signed waiver. The agent API is who sends extra keys.
  .strict();

/**
 * The address a submission carries, as the line to store and the parts beside
 * it.
 *
 * New forms send parts, and the line is composed from them, so the two can
 * never disagree. A client that predates parts (a tab left open across a
 * deploy, an older agent) still sends one line; that is stored as typed with no
 * parts, which the database allows, rather than refused or guessed at.
 */
export function resolveAddressInput(
  line: string | null | undefined,
  parts: AuAddress | null | undefined,
): { address: string; parts: AuAddress | null } {
  if (parts) return { address: composeAuAddress(parts), parts };
  return { address: (line ?? "").trim(), parts: null };
}

/**
 * An address outside Australia as it is checked before it is sent. Only the
 * street line is required, nothing has a format, and the whole line has to fit
 * in the 300 characters an address may be.
 */
const freeText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `Please keep the ${what} under ${max} characters.`)
    .refine((v) => !CONTROL.test(v), `Please keep the ${what} on one line.`);

export const overseasAddressSchema = z
  .object({
    overseas: z.literal(true),
    street: freeText(OVERSEAS_ADDRESS_LIMITS.street, "street address").refine(
      (v) => v.length > 0,
      "Please give the street address.",
    ),
    suburb: freeText(OVERSEAS_ADDRESS_LIMITS.suburb, "town or city"),
    state: freeText(OVERSEAS_ADDRESS_LIMITS.state, "state or region"),
    postcode: freeText(OVERSEAS_ADDRESS_LIMITS.postcode, "postcode"),
    country: freeText(OVERSEAS_ADDRESS_LIMITS.country, "country").optional(),
  })
  .refine((a) => composeOverseasAddress(a).length <= 300, {
    message: "Please shorten the address. It has to fit in 300 characters.",
  });

/**
 * The one line an address outside Australia is stored and printed as: what
 * was given, in envelope order, with nothing invented for what was left out.
 * "10 Downing St, London SW1A 2AA, United Kingdom".
 */
export function composeOverseasAddress(a: {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  country?: string;
}): string {
  const locality = [a.suburb, a.state, a.postcode]
    .map((v) => v.trim())
    .filter(Boolean)
    .join(" ");
  return [a.street.trim(), locality, (a.country ?? "").trim()].filter(Boolean).join(", ");
}

/** A finished draft as parts, trimmed, or `null` while anything is missing or wrong. */
export function completeAuAddress(d: AddressDraft): AuAddress | null {
  if (d.overseas) return null;
  const parsed = auAddressSchema.safeParse(auPartsOf(d));
  return parsed.success ? parsed.data : null;
}

/**
 * What a finished draft sends: the parts of an Australian address, or the one
 * line of an address outside Australia. `null` while it is not finished.
 *
 * The line goes up the same way a line always has (`resolveAddressInput`), so
 * the server needs nothing new for it: stored as given, with no parts.
 */
export function finishedAddress(
  d: AddressDraft,
): { parts: AuAddress; line?: never } | { line: string; parts?: never } | null {
  if (d.overseas) {
    return overseasAddressSchema.safeParse(d).success ? { line: composeOverseasAddress(d) } : null;
  }
  const parts = completeAuAddress(d);
  return parts ? { parts } : null;
}

/**
 * The line a draft reads as so far, for a live preview of the document.
 *
 * The same shape as `composeAuAddress`, and identical to it once the draft is
 * complete; until then it shows whatever has been typed, so a half-filled
 * address previews as half an address rather than as nothing.
 */
export function draftAddressLine(d: AddressDraft): string {
  if (d.overseas) return composeOverseasAddress(d);
  const done = completeAuAddress(d);
  if (done) return composeAuAddress(done);
  const locality = [d.suburb.trim(), d.state, d.postcode.trim()].filter(Boolean).join(" ");
  return [d.street.trim(), locality].filter(Boolean).join(", ");
}

/**
 * Whether two one-line addresses are the same place: the same words once
 * spacing and case are set aside, or the same parts once both are read.
 *
 * The guardian's address is stored resolved, so "the same as the
 * participant's" is recorded as a copy of the participant's line. That copy
 * stops matching character for character the moment the participant's line is
 * rewritten from its parts, and a plain comparison would then show a parent
 * as living somewhere else on their child's next waiver.
 */
export function sameAuAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const flat = (v: string | null | undefined) =>
    (v ?? "")
      .replace(/[\s,]+/g, " ")
      .trim()
      .toLowerCase();
  if (flat(a) === flat(b)) return true;
  const pa = splitAuAddress(a);
  const pb = splitAuAddress(b);
  if (!pa || !pb) return false;
  return (
    pa.street.toLowerCase() === pb.street.toLowerCase() &&
    pa.suburb.toLowerCase() === pb.suburb.toLowerCase() &&
    pa.state === pb.state &&
    pa.postcode === pb.postcode
  );
}

/**
 * A gentle "is that right?" when a postcode does not usually belong to the
 * state chosen, or `null` when there is nothing to say.
 *
 * A note and never a refusal. Australia Post's leading digits are a strong
 * rule with real exceptions: towns on a border carry the neighbouring state's
 * postcode (Barooga NSW is 3644), and refusing those would stop a real person
 * signing. What this catches is the common slip, the wrong state picked from
 * the list next to a right postcode, which would otherwise be printed on a
 * signed waiver and counted in the wrong state. The same table is what keeps
 * `splitAuAddress` from reading "Ultimo VIC 2007" as an address.
 */
export function postcodeStateNote(d: AddressDraft): string | null {
  const postcode = d.postcode.trim();
  if (d.overseas || !isAuState(d.state) || !/^[0-9]{4}$/.test(postcode)) return null;
  if (POSTCODE_LEAD[d.state].test(postcode)) return null;
  const usual = AU_STATES.filter((state) => POSTCODE_LEAD[state].test(postcode));
  if (usual.length === 0) {
    return `${postcode} doesn't look like an Australian postcode. Please check it.`;
  }
  const states = usual.join(" or ");
  return `${postcode} is usually in ${states}, not ${d.state}. Please check the state, unless you're just over the border.`;
}
