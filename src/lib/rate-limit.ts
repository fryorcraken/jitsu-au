// How often the public can write to the club, and how much email that can cost.
//
// Four forms accept a write from somebody who is not signed in: the interest
// form, the contact form, the waiver, and agreeing to the code of conduct (a
// link from the waiver confirmation is enough, no login). Until #52 nothing
// bounded any of them. Each accepted waiver creates an auth user and a PDF, and
// each interest or contact submission emails the address that was typed in and
// every manager. So a script could make the club email strangers by the
// thousand, and the reputation damage to the sending domain lands on the
// sign-in and activation emails too, with nothing on any screen to say so.
//
// Two layers, because they stop different attacks:
//
//   1. A limit per NETWORK on each form. Stops one machine hammering. It has to
//      allow for UTS wifi, which is one address for a whole campus: an O-Week
//      stall or a first class night can put dozens of real people on one
//      network inside an hour. The busiest real day so far was two sign-ups.
//   2. Caps on the EMAIL those forms send, per address and club-wide. Stops many
//      machines at once (no per-network limit can), and stops anyone pointing
//      the club's email at one stranger over and over.
//
// The counting itself is `public.claim_rate_limit` (migration
// 20261030120000_rate_limits.sql); this module is the rules, and stays pure so
// they are testable without a server. `rate-limit.server.ts` does the I/O.
//
// Every limit FAILS OPEN: if the counter cannot be reached, or the server
// cannot tell where a request came from, the submission goes through. A lost
// waiver is worse than a missed limit, which is the rule the waiver form
// already follows for its duplicate check.

/** The forms somebody can submit without being signed in. */
export type PublicForm = "interest" | "contact" | "waiver" | "code_of_conduct";

export type FormLimit = { perHour: number; perDay: number };

/**
 * Submissions allowed per network, per rolling hour and day.
 *
 * 50 an hour leaves a stall on campus wifi room to sign up a crowd. The day
 * limit stops a single machine turning that into 1,200 a day. Contact is
 * tighter because nobody sends a club five questions in an hour, and each one
 * puts a message in front of every manager.
 */
export const FORM_LIMITS: Record<PublicForm, FormLimit> = {
  interest: { perHour: 50, perDay: 150 },
  waiver: { perHour: 50, perDay: 150 },
  code_of_conduct: { perHour: 50, perDay: 150 },
  contact: { perHour: 5, perDay: 20 },
};

/**
 * Emails a day, per rolling 24 hours.
 *
 * - `perRecipient`: to any one typed-in address. Six covers a parent signing
 *   for three children plus themselves, with an interest form besides.
 * - `visitorTotal`: to typed-in addresses altogether, about fifty times the
 *   busiest real day. This is the one that protects the sending domain when
 *   many machines attack at once.
 * - `managerPerKind`: manager copies of each kind (new lead, new message, new
 *   waiver). Counted per submission, not per manager.
 *
 * Past a cap the submission is still saved and still shown on the manager
 * screens; only the email is held back.
 */
export const EMAIL_CAPS = {
  perRecipient: 6,
  visitorTotal: 100,
  managerPerKind: 20,
} as const;

/** The three per-submission emails a manager gets. */
export type ManagerNoticeKind = "lead" | "message" | "waiver";

/** Counter names. Stable strings: they are what the database holds. */
export const BUCKETS = {
  form: (form: PublicForm) => `form:${form}`,
  recipient: "email:recipient",
  visitorTotal: "email:visitor-total",
  manager: (kind: ManagerNoticeKind) => `email:manager:${kind}`,
  managerPaused: (kind: ManagerNoticeKind) => `email:manager-paused:${kind}`,
} as const;

/** The one subject a club-wide counter is kept under. */
export const CLUB_SUBJECT = "club";

/**
 * Expand an IPv6 address to its eight groups, or null if it is not one.
 * Handles `::` compression and an embedded IPv4 tail.
 */
function ipv6Groups(ip: string): string[] | null {
  let addr = ip.toLowerCase().split("%")[0];
  if (!addr.includes(":")) return null;
  const v4 = addr.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    addr =
      addr.slice(0, -v4[0].length) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * The network a request came from, as the per-network limit counts it.
 *
 * An IPv4 address is one network. An IPv6 address counts by its /64, the block
 * a single home or phone connection is handed: anything finer and one machine
 * could rotate through addresses in its own block and never be counted twice.
 * An IPv4 address written as IPv6 (`::ffff:203.0.113.7`) is the IPv4 address.
 *
 * Null when there is no usable address, which the caller treats as "do not
 * limit" rather than lumping every such request into one counter.
 */
export function networkKey(ip: string | null | undefined): string | null {
  const raw = ip?.trim();
  if (!raw) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  const groups = ipv6Groups(raw);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff" ? groups : null;
  if (mapped) {
    const hi = parseInt(mapped[6], 16);
    const lo = parseInt(mapped[7], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** "about 25 minutes", "about 3 hours": how long somebody is asked to wait. */
export function describeWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes === 1) return "a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

const WHAT: Record<PublicForm, string> = {
  interest: "sign-ups",
  waiver: "waivers",
  code_of_conduct: "agreements",
  contact: "messages",
};

/**
 * What somebody who hit a limit is told, in the failure panel under the form.
 *
 * It has to work for the person it will actually reach: a real member on
 * campus wifi, sharing an address with everyone else in the building. So it
 * says it is the NETWORK that is paused, not them; that nothing they typed is
 * lost; and the one thing that gets them through straight away, which is
 * switching to mobile data. One sentence each, under the 300 characters
 * `isInfrastructureBody` allows a human message.
 */
export function rateLimitMessage(form: PublicForm, retryAfterSeconds: number): string {
  return (
    `A lot of ${WHAT[form]} have come from this network recently, so we've paused new ones ` +
    `from it for ${describeWait(retryAfterSeconds)}. Your details are still here. ` +
    `Switch to mobile data and try again, or try again later.`
  );
}
