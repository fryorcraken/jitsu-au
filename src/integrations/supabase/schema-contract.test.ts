import { describe, it, expect } from "vitest";
import type { Database } from "./types";

/**
 * A contract between the app and the *live* database.
 *
 * `types.ts` is generated from the live Supabase schema, so it is the only
 * artifact in this repo that reflects what the database actually has. A
 * migration file sitting in `supabase/migrations/` proves nothing: Lovable does
 * not apply hand-written migrations, and `waivers.approval_status` was missing
 * from production for a week while the migration adding it sat in the repo.
 *
 * Each object below is `satisfies`-checked against a generated Row type, so a
 * column that disappears from the live schema fails `bun run typecheck` at the
 * exact call site instead of failing at runtime with
 * `column waivers.approval_status does not exist`. The runtime assertions keep
 * the check visible in the test report.
 *
 * When you add a column the app reads or writes, add it here.
 */

type Tables = Database["public"]["Tables"];

describe("live schema contract", () => {
  it("waivers carries the approval workflow columns", () => {
    const row = {
      approval_status: "pending",
      approved_at: null,
      approved_by: null,
    } satisfies Partial<Tables["waivers"]["Row"]>;

    expect(Object.keys(row).sort()).toEqual(["approval_status", "approved_at", "approved_by"]);
  });

  it("waivers carries the frozen-submission person fields", () => {
    const row = {
      first_name: "Ada",
      middle_name: null,
      last_name: "Lovelace",
      preferred_name: null,
      email: "ada@example.com",
      uts_student_number: null,
      sms_whatsapp_consent: false,
      signer_ip: null,
      signer_meta: {},
      user_id: "00000000-0000-0000-0000-000000000000",
    } satisfies Partial<Tables["waivers"]["Row"]>;

    expect(row.first_name).toBe("Ada");
  });

  it("waiver_templates carries the manager-editable acknowledgements", () => {
    const row = {
      acknowledgements: [{ id: "risk", label: "I accept the risks.", required: true }],
    } satisfies Partial<Tables["waiver_templates"]["Row"]>;

    expect(row.acknowledgements).toHaveLength(1);
  });

  it("profiles carries the fields waiver approval copies across", () => {
    const row = {
      user_id: "00000000-0000-0000-0000-000000000000",
      first_name: null,
      preferred_name: null,
      uts_student_number: null,
      sms_whatsapp_consent: false,
    } satisfies Partial<Tables["profiles"]["Row"]>;

    expect(row.sms_whatsapp_consent).toBe(false);
  });

  it("interest_registrations carries the consent flag the form writes", () => {
    const row = { sms_whatsapp_consent: true } satisfies Partial<
      Tables["interest_registrations"]["Row"]
    >;

    expect(row.sms_whatsapp_consent).toBe(true);
  });
});
