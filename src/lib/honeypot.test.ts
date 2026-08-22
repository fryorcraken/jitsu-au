import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The honeypot only works if the form actually carries it, so this walks the
 * route files rather than trusting the convention to be followed.
 *
 * Four of the seven honeypots were inert before 2026-08-21: `/waiver` and
 * `/code-of-conduct` rendered `<input type="hidden" name="hp" value="" />` and
 * then hardcoded `hp: ""` in the payload, so the field they rendered was never
 * read and a form-filler would not have filled a hidden input anyway. Nothing
 * failed, no test went red, and the trap simply never fired. That is exactly
 * the kind of defect a source-reading test is for (`seo.test.ts` and
 * `scripts/e2e-conventions.test.ts` are the same idea).
 */
const ROUTES_DIR = join(process.cwd(), "src/routes");

/**
 * Screens that send `hp` with no decoy input on purpose. Both are behind the
 * auth gate, where an attacker has to hold a real session before the honeypot
 * would ever be reached, so the field is carried only to satisfy the schema.
 * Adding a decoy to either is fine; adding a new entry here needs a reason.
 */
const NO_DECOY_INPUT = new Set(["_authenticated/membership.tsx", "kb/$slug.tsx"]);

function routeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...routeFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/** The whole `<input ... />` element that carries `name="hp"`, or null. */
function decoyInput(source: string): string | null {
  const at = source.indexOf('name="hp"');
  if (at === -1) return null;
  const open = source.lastIndexOf("<input", at);
  const close = source.indexOf("/>", at);
  if (open === -1 || close === -1) return null;
  return source.slice(open, close + 2);
}

describe("honeypot wiring across the route files", () => {
  const files = routeFiles(ROUTES_DIR).map((rel) => ({
    rel,
    source: readFileSync(join(ROUTES_DIR, rel), "utf8"),
  }));

  const senders = files.filter((f) => /\bhp[,:]/.test(f.source) || f.source.includes('name="hp"'));

  it("finds the forms that carry a honeypot", () => {
    // A sanity check on the walk itself: if this drops to zero the rest of the
    // suite would pass by testing nothing.
    expect(senders.length).toBeGreaterThanOrEqual(6);
  });

  it.each(senders.map((f) => f.rel))("%s does not hardcode an empty honeypot", (rel) => {
    const { source } = senders.find((f) => f.rel === rel)!;
    if (NO_DECOY_INPUT.has(rel)) return;
    // `hp: ""` in a payload means the field the form renders is never read, so
    // filling the decoy in changes nothing about what the server receives.
    expect(source).not.toContain('hp: ""');
  });

  it.each(senders.map((f) => f.rel))("%s renders a fillable decoy", (rel) => {
    const { source } = senders.find((f) => f.rel === rel)!;
    if (NO_DECOY_INPUT.has(rel)) return;
    const input = decoyInput(source);
    expect(input, `${rel} sends hp but renders no name="hp" input`).not.toBeNull();
    // A `type="hidden"` field is not a honeypot: something filling a form in
    // wholesale fills the visible-in-the-DOM text fields, not hidden ones.
    expect(input).toContain('type="text"');
    // Out of the tab order and out of a password manager's way, so nobody
    // reaches it by keyboard or has it filled for them.
    expect(input).toContain("tabIndex={-1}");
    expect(input).toContain('autoComplete="off"');
    // Hidden from sight one way or the other: `hidden` takes it out of the
    // layout, `sr-only` keeps it in the DOM but off screen. Either is fine, a
    // decoy nobody can see is the point.
    expect(input).toMatch(/className="(hidden|sr-only)"/);
  });
});
