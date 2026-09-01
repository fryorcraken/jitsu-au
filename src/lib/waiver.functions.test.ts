// A saved waiver must never be reported as a failure.
//
// `submitWaiverWithPdf` used to throw when the PDF could not be rendered,
// uploaded, or signed — after the waiver row was already committed. The person
// who had just signed saw an error, and the reliable thing they do next is sign
// again. Everything past the insert now degrades to `pdf_ready: false` instead,
// and `signStoredPdf` is the helper every one of those paths leans on.
//
// `filePaperWaiver` is the other piece of waiver.functions.ts reachable from a
// unit test without a Start request context: like `signStoredPdf`, it takes its
// admin client as a parameter rather than lazy-importing it, because it is
// shared by the manager's upload form (a createServerFn handler) and the
// manager agent HTTP API (a plain route handler, authenticated by bearer token
// instead of a Supabase session) — see src/routes/api/manager/agent.ts action
// `file_waiver`.
//
// Both are testable for the same reason the `createServerFn` handlers around
// them are not: those die on "No Start context found in AsyncLocalStorage"
// when called from the runner (see membership.functions.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { PaperWaiverUploadInput } from "./validation";

// `./waiver-scan` is mocked so a test controls exactly what "the scan" is,
// without needing real PDF/PNG bytes or exercising pdf-lib (that lives in
// waiver-scan.test.ts).
const buildScanPdf = vi.fn(async (pages: unknown) => new Uint8Array([1, 2, 3]));
const decodeBase64 = vi.fn((s: string) => new Uint8Array(Buffer.from(s, "base64")));
vi.mock("./waiver-scan", () => ({
  buildScanPdf: (pages: unknown) => buildScanPdf(pages),
  decodeBase64: (s: string) => decodeBase64(s),
}));

type SignResult = { data: { signedUrl: string } | null; error: { message: string } | null };

/**
 * A service-role stub covering exactly the one storage chain `signStoredPdf`
 * walks. Named apart from the `filePaperWaiver` fake below, which covers a much
 * larger surface (auth, profiles, the waivers table) for a different function
 * in this same module.
 */
function fakeSignStoredPdfAdmin(result: SignResult | (() => never)) {
  const calls: Array<{ bucket: string; path: string; ttl: number }> = [];
  const admin = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl(path: string, ttl: number) {
            calls.push({ bucket, path, ttl });
            if (typeof result === "function") return result();
            return Promise.resolve(result);
          },
        };
      },
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signStoredPdf", () => {
  it("mints a one-hour link from the stored path", async () => {
    const { signStoredPdf } = await import("./waiver.functions");
    const { admin, calls } = fakeSignStoredPdfAdmin({
      data: { signedUrl: "https://example.test/w1.pdf?token=abc" },
      error: null,
    });

    await expect(signStoredPdf(admin, "w1.pdf")).resolves.toBe(
      "https://example.test/w1.pdf?token=abc",
    );
    expect(calls).toEqual([{ bucket: "waivers", path: "w1.pdf", ttl: 3600 }]);
  });

  it("returns null without calling storage when there is no PDF yet", async () => {
    // A real state, not an error: a first attempt that is still mid-flight has
    // inserted its row but has not finished rendering. The retry that finds it
    // must still report the waiver as saved.
    const { signStoredPdf } = await import("./waiver.functions");
    const { admin, calls } = fakeSignStoredPdfAdmin({ data: null, error: null });

    await expect(signStoredPdf(admin, null)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("swallows a storage error rather than failing a signed waiver", async () => {
    const { signStoredPdf } = await import("./waiver.functions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeSignStoredPdfAdmin({
      data: null,
      error: { message: "Object not found" },
    });

    await expect(signStoredPdf(admin, "w1.pdf")).resolves.toBeNull();
  });

  it("swallows a thrown storage failure too", async () => {
    // Storage can reject outright (a network fault inside the SDK), not just
    // return an error object. Both must come back as "no link", never as a throw
    // that would be reported to the signer as a failed submission.
    const { signStoredPdf } = await import("./waiver.functions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeSignStoredPdfAdmin(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(signStoredPdf(admin, "w1.pdf")).resolves.toBeNull();
  });
});

// `code` carries the Postgres SQLSTATE (e.g. 23505 unique_violation), which
// filePaperWaiver branches on to adopt a raced client_submission_id row.
type Result = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });
const fails = (message: string): Result => ({ data: null, error: { message } });

const EXISTING_USER = "22222222-2222-2222-2222-222222222222";
const NEW_USER = "33333333-3333-3333-3333-333333333333";
const MANAGER_ID = "44444444-4444-4444-4444-444444444444";

/**
 * A fake service-role client covering exactly the calls filePaperWaiver makes.
 * `existingId` picks the resolvePersonId branch: a truthy value is an existing
 * person (no createUser call), null/undefined is a brand-new applicant.
 */
/** The two `profiles` columns every household question is answered from. */
type ProfileRow = {
  user_id: string;
  guardian_user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
};

const CHILD_ONE = "55555555-5555-5555-5555-555555555555";
const CHILD_TWO = "66666666-6666-6666-6666-666666666666";

function fakeAdmin(opts: {
  existingId?: string | null;
  createUser?: Result;
  /** Rows already on the books, keyed by user id. */
  profiles?: ProfileRow[];
  /** What the `profiles` upsert answers with. */
  profileUpsert?: Result;
  /** The ids `createUser` hands out, in order. */
  mintedUserIds?: string[];
  /** Rows the same-person + same-signing-date duplicate probe finds. */
  duplicates?: Result;
  /**
   * An already-filed waiver carrying this call's client_submission_id. A null
   * `pdf_path` means a previous attempt inserted the row but never stored its
   * scan, which is a half-filed waiver, not a finished one.
   */
  priorSubmission?: {
    id: string;
    user_id: string;
    pdf_path: string | null;
    email?: string;
    signed_at?: string;
    signer_meta?: { source: string };
  } | null;
  /** The row the unique index says won, looked up after a 23505 insert. */
  racedSubmission?: {
    id: string;
    user_id: string;
    pdf_path: string | null;
    signer_meta?: { source: string };
  } | null;
  insert?: Result;
  /** The row a resume-write (`.update(...).select("id").single()`) resolves to. */
  resumeUpdate?: Result;
  upload?: { error: { message: string } | null };
  delete?: { error: { message: string } | null };
  pdfPathUpdate?: { error: { message: string } | null };
  remove?: { error: { message: string } | null };
  getUserByIdEmail?: string | null;
}) {
  const profiles = new Map<string, ProfileRow>(
    (opts.profiles ?? []).map((row) => [row.user_id, row]),
  );
  const mintedUserIds = opts.mintedUserIds ?? [];
  const inserted = opts.insert ?? ok({ id: "waiver-1" });
  const resumeUpdate = opts.resumeUpdate ?? ok({ id: "resumed" });
  const upload = opts.upload ?? { error: null };
  const del = opts.delete ?? { error: null };
  const pdfPathUpdate = opts.pdfPathUpdate ?? { error: null };
  const remove = opts.remove ?? { error: null };

  const calls = {
    rpc: [] as string[],
    createUser: [] as unknown[],
    upsert: [] as unknown[],
    insert: [] as unknown[],
    selects: [] as string[],
    updates: [] as unknown[],
    deletes: [] as string[],
    uploads: [] as { path: string; bytes: unknown }[],
    removes: [] as string[][],
    getUserById: [] as string[],
    deleteUser: [] as string[],
  };

  const admin = {
    rpc: (name: string) => {
      calls.rpc.push(name);
      if (name === "user_id_by_email") return Promise.resolve(ok(opts.existingId ?? null));
      throw new Error(`unexpected rpc ${name}`);
    },
    auth: {
      admin: {
        createUser: (args: unknown) => {
          calls.createUser.push(args);
          if (opts.createUser) {
            return Promise.resolve(opts.createUser) as unknown as Promise<{
              data: { user: { id: string } | null };
              error: unknown;
            }>;
          }
          // A DISTINCT id per call, which the fake used to fake away by always
          // answering NEW_USER. Two children on one account are two auth users
          // and the whole point of #105, so a stub that hands both the same id
          // would report the bug as fixed while reproducing it exactly.
          const id = mintedUserIds[calls.createUser.length - 1] ?? NEW_USER;
          const row = { user: { id } };
          // The profile row every real createUser leaves behind, courtesy of
          // the ensure_profile trigger. `resolveDependantId` upserts onto it.
          profiles.set(id, { user_id: id, guardian_user_id: null });
          return Promise.resolve(ok(row)) as unknown as Promise<{
            data: { user: { id: string } | null };
            error: unknown;
          }>;
        },
        deleteUser: (id: string) => {
          calls.deleteUser.push(id);
          profiles.delete(id);
          return Promise.resolve(ok(null)) as unknown as Promise<{ error: unknown }>;
        },
        getUserById: (id: string) => {
          calls.getUserById.push(id);
          return Promise.resolve(
            ok({ user: opts.getUserByIdEmail ? { email: opts.getUserByIdEmail } : null }),
          ) as unknown as Promise<{ data: { user: { email: string } | null } }>;
        },
      },
    },
    from: (table: string) => {
      if (table === "profiles") {
        return {
          upsert: (row: ProfileRow) => {
            calls.upsert.push(row);
            profiles.set(row.user_id, { ...profiles.get(row.user_id), ...row });
            return Promise.resolve(opts.profileUpsert ?? ok(null));
          },
          // Two shapes of read reach this table, and they are told apart by
          // which column they filter on, exactly as the real queries are:
          // `assertMayHaveDependants` and `listHousehold`'s first half look up
          // one person by `user_id`, and `listHousehold`'s second half lists
          // everyone whose `guardian_user_id` is that person.
          select: () => {
            const query = {
              eq: (column: string, value: string) => {
                if (column === "guardian_user_id") {
                  const rows = [...profiles.values()].filter((r) => r.guardian_user_id === value);
                  return { order: () => Promise.resolve(ok(rows)) };
                }
                return {
                  maybeSingle: () => Promise.resolve(ok(profiles.get(value) ?? null)),
                  ...query,
                };
              },
            };
            return query;
          },
        };
      }
      if (table === "waivers") {
        const dupProbe = {
          eq: () => dupProbe,
          // The probe matches a RANGE over the signing day, not equality on
          // midnight — an online waiver stores a real wall-clock time.
          gte: () => dupProbe,
          lt: () => dupProbe,
          order: () => dupProbe,
          limit: () => Promise.resolve(opts.duplicates ?? ok([])),
        };
        // The client_submission_id lookups (before any work, and again after a
        // unique violation) both end in maybeSingle, on different column lists.
        // Which row comes back depends on whether the insert has run yet.
        const submissionLookup = {
          eq: () => submissionLookup,
          maybeSingle: () => {
            const row = calls.insert.length
              ? (opts.racedSubmission ?? null)
              : (opts.priorSubmission ?? null);
            // The pre-work lookup also reads email/signed_at to prove the id
            // belongs to THIS record. Default them to the fixture's own values
            // so a test only sets them when it is checking the mismatch.
            return Promise.resolve(
              ok(
                row
                  ? // The DATABASE read format: PostgREST renders TIMESTAMPTZ as
                    // offset notation with no fractional part when it is zero.
                    // Deliberately NOT the `…T00:00:00.000Z` this module writes —
                    // a fixture in the write format hid a bug where every keyed
                    // retry was refused as belonging to a different waiver.
                    {
                      email: "ada@example.com",
                      signed_at: "2020-01-15T00:00:00+00:00",
                      // The lookups only ever resolve PAPER filings: the key
                      // namespace is shared with the public signing path.
                      signer_meta: { source: "paper_upload" },
                      ...row,
                    }
                  : null,
              ),
            );
          },
        };
        return {
          select: (cols: string) => {
            calls.selects.push(cols);
            // Only the duplicate probe has its own distinct column list; every
            // other select in this module is a client_submission_id lookup.
            return cols.startsWith("id, approval_status") ? dupProbe : submissionLookup;
          },
          insert: (row: unknown) => {
            calls.insert.push(row);
            return { select: () => ({ single: () => Promise.resolve(inserted) }) };
          },
          update: (patch: unknown) => {
            calls.updates.push(patch);
            // Two distinct update chains land here: the plain `.update(...).eq(...)`
            // used for the final pdf_path-only write (awaited directly, so `eq`
            // must itself be thenable), and the resume-write
            // `.update(...).eq(...).select("id").single()` used to refresh a
            // matched row with this call's own data.
            return {
              eq: () => {
                const plain = Promise.resolve(pdfPathUpdate);
                return {
                  then: (onFulfilled: unknown, onRejected: unknown) =>
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    plain.then(onFulfilled as any, onRejected as any),
                  select: () => ({ single: () => Promise.resolve(resumeUpdate) }),
                };
              },
            };
          },
          delete: () => ({
            eq: (_col: string, id: string) => {
              calls.deletes.push(id);
              return Promise.resolve(del);
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, bytes: unknown) => {
          expect(bucket).toBe("waivers");
          calls.uploads.push({ path, bytes });
          return Promise.resolve(upload);
        },
        remove: (paths: string[]) => {
          expect(bucket).toBe("waivers");
          calls.removes.push(paths);
          return Promise.resolve(remove);
        },
      }),
    },
  };

  // Cast once here rather than at every call site, the same way
  // `fakeSignStoredPdfAdmin` above does. The existing `admin as any` casts
  // below are left alone: they still compile, and rewriting twenty unrelated
  // lines is not what this change is for.
  return { admin: admin as unknown as SupabaseClient<Database>, calls, profiles };
}

const validInput: PaperWaiverUploadInput = {
  first_name: "Ada",
  middle_name: "",
  last_name: "Lovelace",
  preferred_name: "",
  date_of_birth: "1990-12-10",
  address: "1 Broadway, Ultimo NSW",
  phone: "0400000000",
  signing_for: "self",
  email: "Ada@Example.com",
  uts_student_number: "",
  sms_whatsapp_consent: false,
  // A 2020 paper form, so the media question is not on it at all.
  media_consent: null,
  emergency_contact_name: "Charles Babbage",
  emergency_contact_relationship: "Colleague",
  emergency_contact_phone: "0400000001",
  medical_notes: "",
  signed_on: "2020-01-15",
  template_version: 3,
  scan: [{ name: "waiver.pdf", type: "application/pdf", data: "aGlw" }],
  confirm_duplicate: false,
};

/**
 * A profiles-table stub for `applyWaiverGiSize`: one read chain and one write
 * chain, recording every patch so a test can assert what was (and was not)
 * written. `row: null` is "no profile"; `readError`/`writeError` force the
 * failure paths; `updatedRows` forces the zero-rows-matched case.
 */
function fakeProfilesAdmin(opts: {
  row?: { gi_size: string | null; belt_size: string | null } | null;
  readError?: string;
  writeError?: string;
  updatedRows?: unknown[];
}) {
  const patches: Record<string, unknown>[] = [];
  const admin = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.row === undefined ? { gi_size: null, belt_size: null } : opts.row,
                error: opts.readError ? { message: opts.readError } : null,
              }),
            }),
          };
        },
        update(patch: Record<string, unknown>) {
          patches.push(patch);
          return {
            eq: () => ({
              select: async () => ({
                data: opts.updatedRows ?? [{ user_id: "u1" }],
                error: opts.writeError ? { message: opts.writeError } : null,
              }),
            }),
          };
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, patches };
}

describe("applyWaiverGiSize", () => {
  const PERSON = "u1";

  it("refuses to touch an existing person without proof the submitter is them", async () => {
    // THE security boundary. /waiver is public and unauthenticated, and
    // resolvePersonId resolves any known email to that existing person, so
    // without this anyone could POST a member's address and rewrite their
    // record. Nothing may be written, and nothing may be read either.
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: "2", belt_size: "2" } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    const result = await applyWaiverGiSize(admin, {
      userId: PERSON,
      giSize: "7",
      identityProven: false,
    });

    expect(result).toBe("skipped");
    expect(patches).toHaveLength(0);
  });

  it("writes the size when the submitter is proven to be that person", async () => {
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: "2", belt_size: "3" } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    const result = await applyWaiverGiSize(admin, {
      userId: PERSON,
      giSize: "5",
      identityProven: true,
    });

    expect(result).toBe("written");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ gi_size: "5" });
    // A record that already carries sizing keeps the belt it has.
    expect(patches[0]).not.toHaveProperty("belt_size");
    expect(patches[0].updated_at).toEqual(expect.any(String));
  });

  it("writes nothing at all for a blank size, so re-signing never clears one", async () => {
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: "4", belt_size: "4" } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    for (const blank of ["", null, undefined]) {
      expect(
        await applyWaiverGiSize(admin, { userId: PERSON, giSize: blank, identityProven: true }),
      ).toBe("skipped");
    }
    expect(patches).toHaveLength(0);
  });

  it("fills in the belt only when the record carries no sizing at all", async () => {
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: null, belt_size: null } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await applyWaiverGiSize(admin, { userId: PERSON, giSize: "3", identityProven: true });

    expect(patches[0]).toMatchObject({ gi_size: "3", belt_size: "3" });
  });

  it("sends a kids' gi size to the shortest belt the club stocks", async () => {
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: null, belt_size: null } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await applyWaiverGiSize(admin, { userId: PERSON, giSize: "000", identityProven: true });

    // There is no 000 or 00 belt on the club's chart.
    expect(patches[0]).toMatchObject({ gi_size: "000", belt_size: "0" });
  });

  it("never puts back a belt somebody cleared on purpose", async () => {
    // gi set, belt null = deliberately cleared on /account, NOT "never sized".
    const { admin, patches } = fakeProfilesAdmin({ row: { gi_size: "4", belt_size: null } });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await applyWaiverGiSize(admin, { userId: PERSON, giSize: "5", identityProven: true });

    expect(patches[0]).toMatchObject({ gi_size: "5" });
    expect(patches[0]).not.toHaveProperty("belt_size");
  });

  it("refuses to guess when the read fails, rather than re-seeding a belt", async () => {
    const { admin, patches } = fakeProfilesAdmin({ readError: "connection reset" });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await expect(
      applyWaiverGiSize(admin, { userId: PERSON, giSize: "5", identityProven: true }),
    ).rejects.toThrow("connection reset");
    expect(patches).toHaveLength(0);
  });

  it("throws when there is no profile row to write to", async () => {
    const { admin, patches } = fakeProfilesAdmin({ row: null });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await expect(
      applyWaiverGiSize(admin, { userId: PERSON, giSize: "5", identityProven: true }),
    ).rejects.toThrow(/No profile/);
    expect(patches).toHaveLength(0);
  });

  it("does not report success when the update matched no rows", async () => {
    // PostgREST returns no error when the filter matched nothing, so without
    // checking the returned rows this would claim to have written.
    const { admin } = fakeProfilesAdmin({
      row: { gi_size: null, belt_size: null },
      updatedRows: [],
    });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await expect(
      applyWaiverGiSize(admin, { userId: PERSON, giSize: "5", identityProven: true }),
    ).rejects.toThrow(/No profile/);
  });

  it("surfaces a write error", async () => {
    const { admin } = fakeProfilesAdmin({
      row: { gi_size: null, belt_size: null },
      writeError: "violates check constraint",
    });
    const { applyWaiverGiSize } = await import("./waiver.functions");

    await expect(
      applyWaiverGiSize(admin, { userId: PERSON, giSize: "5", identityProven: true }),
    ).rejects.toThrow("violates check constraint");
  });
});

describe("applyWaiverMartialArtsExperience", () => {
  const PERSON = "u1";

  it("refuses to touch an existing person without proof the submitter is them", async () => {
    // Same security boundary as applyWaiverGiSize: /waiver is public and
    // unauthenticated, so nothing may be written without proof of identity.
    const { admin, patches } = fakeProfilesAdmin({});
    const { applyWaiverMartialArtsExperience } = await import("./waiver.functions");

    const result = await applyWaiverMartialArtsExperience(admin, {
      userId: PERSON,
      experience: "2 years BJJ",
      identityProven: false,
    });

    expect(result).toBe("skipped");
    expect(patches).toHaveLength(0);
  });

  it("writes the trimmed experience when the submitter is proven to be that person", async () => {
    const { admin, patches } = fakeProfilesAdmin({});
    const { applyWaiverMartialArtsExperience } = await import("./waiver.functions");

    const result = await applyWaiverMartialArtsExperience(admin, {
      userId: PERSON,
      experience: "  total beginner  ",
      identityProven: true,
    });

    expect(result).toBe("written");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ martial_arts_experience: "total beginner" });
    expect(patches[0].updated_at).toEqual(expect.any(String));
  });

  it("writes nothing at all for a blank value, so re-signing never clears one", async () => {
    const { admin, patches } = fakeProfilesAdmin({});
    const { applyWaiverMartialArtsExperience } = await import("./waiver.functions");

    for (const blank of ["", "   ", null, undefined]) {
      expect(
        await applyWaiverMartialArtsExperience(admin, {
          userId: PERSON,
          experience: blank,
          identityProven: true,
        }),
      ).toBe("skipped");
    }
    expect(patches).toHaveLength(0);
  });

  it("does not report success when the update matched no rows", async () => {
    const { admin } = fakeProfilesAdmin({ updatedRows: [] });
    const { applyWaiverMartialArtsExperience } = await import("./waiver.functions");

    await expect(
      applyWaiverMartialArtsExperience(admin, {
        userId: PERSON,
        experience: "2 years BJJ",
        identityProven: true,
      }),
    ).rejects.toThrow(/No profile/);
  });

  it("surfaces a write error", async () => {
    const { admin } = fakeProfilesAdmin({ writeError: "violates check constraint" });
    const { applyWaiverMartialArtsExperience } = await import("./waiver.functions");

    await expect(
      applyWaiverMartialArtsExperience(admin, {
        userId: PERSON,
        experience: "2 years BJJ",
        identityProven: true,
      }),
    ).rejects.toThrow("violates check constraint");
  });
});

describe("filePaperWaiver", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    buildScanPdf.mockClear();
    decodeBase64.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("files against an existing person without creating a new one", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await filePaperWaiver(admin as any, validInput, MANAGER_ID);

    expect(result).toEqual({ id: "waiver-1", user_id: EXISTING_USER, created: true });
    expect(calls.createUser).toHaveLength(0);
    expect(calls.insert).toHaveLength(1);
    const row = calls.insert[0] as Record<string, unknown>;
    // Email normalized, not stored as typed.
    expect(row.email).toBe("ada@example.com");
    expect(row.user_id).toBe(EXISTING_USER);
    // Signed at midnight UTC on the date written on the paper, not today.
    expect(row.signed_at).toBe("2020-01-15T00:00:00.000Z");
    expect(row.signer_ip).toBeNull();
    const meta = row.signer_meta as Record<string, unknown>;
    expect(meta.source).toBe("paper_upload");
    expect(meta.uploaded_by).toBe(MANAGER_ID);
    expect(meta.scan_files).toEqual(["waiver.pdf"]);
    // The scan is uploaded to <waiver id>.pdf, then the row points at it.
    expect(calls.uploads[0].path).toBe("waiver-1.pdf");
    expect(calls.updates[0]).toEqual({ pdf_path: "waiver-1.pdf" });
  });

  it("creates a locked applicant for an email the club has never seen", async () => {
    const { admin, calls } = fakeAdmin({ existingId: null });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await filePaperWaiver(admin as any, validInput, MANAGER_ID);

    expect(result.user_id).toBe(NEW_USER);
    expect(calls.createUser).toHaveLength(1);
    // Never verified by a paper filing: a manager holding paper is not proof
    // anyone can read the mailbox written on it.
    expect(calls.createUser[0]).toMatchObject({ email: "ada@example.com", email_confirm: false });
    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0]).toMatchObject({ user_id: NEW_USER, first_name: "Ada" });
  });

  it("derives minority from the signing date, not today, and fills the guardian block", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    const minorInput: PaperWaiverUploadInput = {
      ...validInput,
      date_of_birth: "2003-05-01",
      signed_on: "2019-06-01", // 16 at the time, an adult today
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, minorInput, MANAGER_ID);

    const row = calls.insert[0] as Record<string, unknown>;
    expect(row.is_minor).toBe(true);
    // The old paper layout names one person, who is therefore the signer, and
    // their contact details fall back to the participant's.
    expect(row.guardian_name).toBe("Charles Babbage");
    expect(row.guardian_relationship).toBe("Colleague");
    expect(row.guardian_phone).toBe(validInput.phone);
    expect(row.guardian_address).toBe(validInput.address);
    expect(row.guardian_email).toBe("ada@example.com");
  });

  // The current paper form names the guardian separately from the emergency
  // contact, and they can be two different people.
  it("files a guardian who is not the emergency contact, with their own details", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    const minorInput: PaperWaiverUploadInput = {
      ...validInput,
      date_of_birth: "2003-05-01",
      signed_on: "2019-06-01",
      guardian_name: "Anne Byron",
      guardian_relationship: "Mother",
      guardian_phone: "0400 999 999",
      guardian_email: "anne@example.com",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, minorInput, MANAGER_ID);

    const row = calls.insert[0] as Record<string, unknown>;
    expect(row.guardian_name).toBe("Anne Byron");
    expect(row.guardian_relationship).toBe("Mother");
    expect(row.guardian_phone).toBe("0400 999 999");
    expect(row.guardian_email).toBe("anne@example.com");
    // Not given, so it stands for the participant's.
    expect(row.guardian_address).toBe(validInput.address);
    // The emergency contact is untouched: a different person entirely.
    expect(row.emergency_contact_name).toBe(validInput.emergency_contact_name);
  });

  it("leaves the guardian columns empty for an adult's paper form", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, MANAGER_ID);

    const row = calls.insert[0] as Record<string, unknown>;
    expect(row.is_minor).toBe(false);
    expect(row.guardian_name).toBeNull();
    expect(row.guardian_phone).toBeNull();
    expect(row.guardian_email).toBeNull();
  });

  it("rejects a signing date in the future", async () => {
    const { admin } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    const future = { ...validInput, signed_on: "2099-01-01" };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, future, MANAGER_ID),
    ).rejects.toThrow(/future/i);
  });

  it("never creates a person or a row when the scan cannot be read", async () => {
    buildScanPdf.mockRejectedValueOnce(new Error('Could not read "waiver.pdf": bad PDF'));
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow(/bad PDF/);
    expect(calls.insert).toHaveLength(0);
    expect(calls.createUser).toHaveLength(0);
  });

  it("reports a bad base64 file by index, not the raw atob error", async () => {
    decodeBase64.mockImplementationOnce(() => {
      throw new DOMException(
        "atob() called with invalid base64-encoded data. (Only whitespace, '+', '/', and alphanumeric characters are allowed.)",
      );
    });
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow("scan[0] is not valid base64.");
    expect(calls.insert).toHaveLength(0);
    expect(calls.createUser).toHaveLength(0);
  });

  it("removes the empty row when the scan fails to store, and says so", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      upload: { error: { message: "storage down" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow(/try again/i);
    expect(calls.deletes).toEqual(["waiver-1"]);
    expect(calls.updates).toHaveLength(0);
  });

  it("says the cleanup itself failed rather than pretending it succeeded", async () => {
    const { admin } = fakeAdmin({
      existingId: EXISTING_USER,
      upload: { error: { message: "storage down" } },
      delete: { error: { message: "row locked" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow(/could not be cleaned up/i);
  });

  it("unwinds the row AND the already-stored scan when linking pdf_path fails", async () => {
    // The scan uploaded fine, so this is the case a plain "upload failed" retry
    // would not catch: without cleanup, the PDF sits in storage with no row
    // pointing at it (or a row with a null pdf_path a manager could approve
    // blind), and a retry files a second waiver alongside the orphaned first.
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      pdfPathUpdate: { error: { message: "statement timeout" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow(/try again/i);
    expect(calls.uploads[0].path).toBe("waiver-1.pdf");
    expect(calls.deletes).toEqual(["waiver-1"]);
    expect(calls.removes).toEqual([["waiver-1.pdf"]]);
  });

  it("says so when the orphaned waiver row could not be removed either", async () => {
    const { admin } = fakeAdmin({
      existingId: EXISTING_USER,
      pdfPathUpdate: { error: { message: "statement timeout" } },
      delete: { error: { message: "row locked" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toThrow(/could not be cleaned up/i);
  });

  // Re-posting a byte-identical payload used to mint another waiver every time,
  // leaving a pile of identical pending rows for one person. Each one is another
  // chance to approve the wrong one, and the active waiver is the last APPROVED,
  // not the last signed, so the insurance record depends on approval order.
  it("refuses a second waiver for the same person and signing date", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      duplicates: ok([
        { id: "waiver-earlier", approval_status: "pending", signed_at: "2020-01-15T00:00:00.000Z" },
      ]),
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { DuplicateWaiverError } = await import("./waiver-duplicates");

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toBeInstanceOf(DuplicateWaiverError);
    // Nothing filed, nothing uploaded: the refusal happens before the insert.
    expect(calls.insert).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
  });

  it("carries the colliding waivers on the error so a caller can go and look", async () => {
    const { admin } = fakeAdmin({
      existingId: EXISTING_USER,
      duplicates: ok([
        { id: "waiver-a", approval_status: "pending", signed_at: "2020-01-15T00:00:00.000Z" },
        { id: "waiver-b", approval_status: "approved", signed_at: "2020-01-15T00:00:00.000Z" },
      ]),
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { DuplicateWaiverError } = await import("./waiver-duplicates");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await filePaperWaiver(admin as any, validInput, MANAGER_ID).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateWaiverError);
    expect((err as InstanceType<typeof DuplicateWaiverError>).existing).toEqual([
      { id: "waiver-a", approval_status: "pending", signed_on: "2020-01-15" },
      { id: "waiver-b", approval_status: "approved", signed_on: "2020-01-15" },
    ]);
  });

  // A corrected re-scan of one signing date is a real second document, so the
  // check warns and confirms rather than blocking outright.
  it("files anyway when the caller confirms the duplicate", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      duplicates: ok([
        { id: "waiver-earlier", approval_status: "pending", signed_at: "2020-01-15T00:00:00.000Z" },
      ]),
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    const result = await filePaperWaiver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin as any,
      { ...validInput, confirm_duplicate: true },
      MANAGER_ID,
    );
    expect(result).toEqual({ id: "waiver-1", user_id: EXISTING_USER, created: true });
    expect(calls.insert).toHaveLength(1);
    // Confirmed means the probe is not even run.
    expect(calls.selects).toHaveLength(0);
  });

  it("files a waiver signed on a different date without complaint", async () => {
    // The probe filters on signed_at, so a different date finds nothing.
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER, duplicates: ok([]) });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, MANAGER_ID);
    expect(calls.selects).toEqual(["id, approval_status, signed_at"]);
    expect(calls.insert).toHaveLength(1);
  });

  // A transient probe failure is not a verdict on the waiver, so it gets its own
  // error type rather than being folded in with an unreadable scan. It must NOT
  // advertise confirm_duplicate as the remedy: a retry policy that applied that
  // advice mechanically would disable the check for a real duplicate too.
  it("fails closed with a distinct error if the duplicate check itself errors", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      duplicates: { data: null, error: { message: "connection reset" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { DuplicateCheckFailedError } = await import("./waiver-duplicates");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await filePaperWaiver(admin as any, validInput, MANAGER_ID).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateCheckFailedError);
    expect((err as Error).message).not.toMatch(/confirm_duplicate/);
    expect(calls.insert).toHaveLength(0);
  });

  // A refused filing must leave nothing behind. The external probe verified this
  // for a validation failure; the duplicate probe added two new ways to refuse,
  // and creating the person before them would strand a locked auth user and a
  // profile for someone who has no waiver — afterwards indistinguishable from a
  // real lead, and holding that email address for good.
  // An address the club has never seen cannot have a same-date waiver, so the
  // probe is not consulted for one. That is what stops a probe failure from
  // stranding a locked auth user and a profile for somebody with no waiver —
  // afterwards indistinguishable from a real lead, and holding that email for
  // good. Proven by giving it a probe that WOULD fail and filing anyway.
  it("never lets the duplicate probe strand a newly created person", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: null,
      duplicates: { data: null, error: { message: "connection reset" } },
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await filePaperWaiver(admin as any, validInput, MANAGER_ID);

    expect(result.user_id).toBe(NEW_USER);
    // The probe was skipped, not merely survived.
    expect(calls.selects).not.toContain("id, approval_status, signed_at");
  });

  // The mirror: an address the club DOES know runs the probe, and it runs
  // against the existing person, so a refusal creates nothing either way.
  it("probes against the existing person, creating nobody when it refuses", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      duplicates: ok([
        { id: "w-1", approval_status: "pending", signed_at: "2020-01-15T00:00:00.000Z" },
      ]),
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { DuplicateWaiverError } = await import("./waiver-duplicates");

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filePaperWaiver(admin as any, validInput, MANAGER_ID),
    ).rejects.toBeInstanceOf(DuplicateWaiverError);
    expect(calls.selects).toContain("id, approval_status, signed_at");
    expect(calls.createUser).toHaveLength(0);
    expect(calls.upsert).toHaveLength(0);
  });

  it("says 'at least' when there are more same-date waivers than the probe returns", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `w-${i}`,
      approval_status: "pending",
      signed_at: "2020-01-15T00:00:00.000Z",
    }));
    const { admin } = fakeAdmin({ existingId: EXISTING_USER, duplicates: ok(many) });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { DuplicateWaiverError } = await import("./waiver-duplicates");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await filePaperWaiver(admin as any, validInput, MANAGER_ID).catch((e) => e);
    const dup = err as InstanceType<typeof DuplicateWaiverError>;
    expect(dup.truncated).toBe(true);
    // Capped at 20, and the message must not report the cap as the total.
    expect(dup.existing).toHaveLength(20);
    expect(dup.message).toMatch(/at least 20 waivers/);
  });

  // The duplicate check is check-then-insert: it cannot see an attempt that has
  // not committed yet, so two retries racing each other would both pass it.
  // client_submission_id is what actually makes a retry safe.
  describe("client_submission_id", () => {
    const SUBMISSION = "99999999-9999-9999-9999-999999999999";
    const withId = { ...validInput, client_submission_id: SUBMISSION };

    // A matched row is refreshed with THIS call's data, not treated as a pure
    // no-op — see the two tests below for why: a keyed retry is not always a
    // byte-identical bulk-import replay, and a silent no-op on a "complete"
    // match would report success without ever saving a correction a human
    // made before retrying.
    it("resolves to the matched waiver, updated, when one is already fully filed", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: {
          id: "waiver-first",
          user_id: EXISTING_USER,
          pdf_path: "waiver-first.pdf",
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, withId, MANAGER_ID);

      // A replay: this call did not create it.
      expect(result).toEqual({ id: "waiver-first", user_id: EXISTING_USER, created: false });
      // No SECOND waiver, but the match is written to (update), not skipped.
      expect(calls.insert).toHaveLength(0);
      expect(calls.updates.length).toBeGreaterThan(0);
    });

    // The regression this whole block exists to prevent: a manager whose first
    // attempt half-filed (or even fully filed, if only the success reply was
    // lost) can fix a typo before retrying. Treating a matched row as read-only
    // past its first write would silently keep the OLD value and report success.
    it("writes this call's own field values onto a matched row, not just the scan path", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: { id: "waiver-half", user_id: EXISTING_USER, pdf_path: null },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      const corrected = { ...withId, phone: "0400009999" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await filePaperWaiver(admin as any, corrected, MANAGER_ID);

      const resumeWrite = calls.updates[0] as Record<string, unknown>;
      expect(resumeWrite.phone).toBe("0400009999");
    });

    it("refreshes a fully-filed row's fields too, not just returning the old copy", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: {
          id: "waiver-first",
          user_id: EXISTING_USER,
          pdf_path: "waiver-first.pdf",
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      const corrected = { ...withId, phone: "0400009999" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, corrected, MANAGER_ID);

      expect(result).toEqual({ id: "waiver-first", user_id: EXISTING_USER, created: false });
      const resumeWrite = calls.updates[0] as Record<string, unknown>;
      expect(resumeWrite.phone).toBe("0400009999");
    });

    it("surfaces a failure writing a matched row, rather than treating it as saved", async () => {
      const { admin } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: { id: "waiver-half", user_id: EXISTING_USER, pdf_path: null },
        resumeUpdate: fails("statement timeout"),
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, withId, MANAGER_ID),
      ).rejects.toThrow(/statement timeout/);
    });

    // The dangerous case. A row exists but its scan never stored, so reporting
    // it as filed would hand back a waiver with no document — and a manager can
    // approve that into somebody's ACTIVE insurance record without noticing.
    it("finishes a half-filed row rather than reporting it as already filed", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: { id: "waiver-half", user_id: EXISTING_USER, pdf_path: null },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, withId, MANAGER_ID);

      expect(result).toEqual({ id: "waiver-half", user_id: EXISTING_USER, created: false });
      // No second waiver: it resumes the row it found...
      expect(calls.insert).toHaveLength(0);
      // ...and actually stores the scan against it, which is what was missing.
      expect(calls.uploads[0].path).toBe("waiver-half.pdf");
      // Two writes: the resume-write refreshing the row's fields, then the
      // pdf_path-only write once the scan is stored.
      expect(calls.updates).toHaveLength(2);
      expect(calls.updates[1]).toEqual({ pdf_path: "waiver-half.pdf" });
    });

    // The lookup reads signed_at back from Postgres, which renders TIMESTAMPTZ
    // as `+00:00` with no fractional part — not the `.000Z` this module writes.
    // Comparing the raw strings made every keyed retry look like a different
    // record, so the whole idempotency path was dead.
    it("matches a retry despite the database's timestamp format differing from ours", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: {
          id: "waiver-first",
          user_id: EXISTING_USER,
          pdf_path: "waiver-first.pdf",
          signed_at: "2020-01-15T00:00:00+00:00",
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, withId, MANAGER_ID);
      expect(result).toEqual({ id: "waiver-first", user_id: EXISTING_USER, created: false });
      expect(calls.insert).toHaveLength(0);
    });

    // One partial unique index covers the whole table, so a caller-chosen id can
    // land on a waiver a signer's own browser minted. This endpoint may only
    // ever resolve its own records.
    it("refuses to resolve an id that belongs to an online signing, not a paper filing", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        priorSubmission: {
          id: "waiver-online",
          user_id: EXISTING_USER,
          pdf_path: "waiver-online.pdf",
          signer_meta: { source: "web" },
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      const { SubmissionIdConflictError } = await import("./waiver-duplicates");
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, withId, MANAGER_ID),
      ).rejects.toBeInstanceOf(SubmissionIdConflictError);
      expect(calls.insert).toHaveLength(0);
    });

    it("raises a typed, retryable error when the scan fails to store", async () => {
      const { admin } = fakeAdmin({
        existingId: EXISTING_USER,
        upload: { error: { message: "storage down" } },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      const { WaiverFilingIncompleteError } = await import("./waiver-duplicates");
      // Typed so the API can map it to a 5xx: the row is half-filed and only a
      // retry with the same id completes it. A 4xx would tell a well-behaved
      // caller to change the request, and the only thing to change is the id.
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, withId, MANAGER_ID),
      ).rejects.toBeInstanceOf(WaiverFilingIncompleteError);
    });

    it("refuses an id already used for a different record instead of returning its waiver", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        // Same key, different person: a loop that minted one id per BATCH.
        priorSubmission: {
          id: "waiver-other",
          user_id: EXISTING_USER,
          pdf_path: "waiver-other.pdf",
          email: "someone.else@example.com",
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, withId, MANAGER_ID),
      ).rejects.toThrow(/already belongs to a different waiver/i);
      expect(calls.insert).toHaveLength(0);
    });

    it("adopts the winner's row when two retries race past the lookup", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        // Lookup finds nothing (the other attempt had not committed yet), then
        // the unique index rejects this insert.
        insert: { data: null, error: { message: "duplicate key", code: "23505" } },
        racedSubmission: {
          id: "waiver-winner",
          user_id: EXISTING_USER,
          pdf_path: "waiver-winner.pdf",
        },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, withId, MANAGER_ID);

      expect(result).toEqual({ id: "waiver-winner", user_id: EXISTING_USER, created: false });
      // No second waiver, and no scan uploaded over the winner's.
      expect(calls.uploads).toHaveLength(0);
    });

    // Losing the insert race to an attempt that is ITSELF still uploading. Both
    // carry the same scan and write to the same path, so finishing the winner's
    // row is safe — and stops this attempt returning success for a document
    // that the winner might yet fail to store.
    it("finishes the winner's row when the winner has not stored its scan yet", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        insert: { data: null, error: { message: "duplicate key", code: "23505" } },
        racedSubmission: { id: "waiver-winner", user_id: EXISTING_USER, pdf_path: null },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await filePaperWaiver(admin as any, withId, MANAGER_ID);

      expect(result).toEqual({ id: "waiver-winner", user_id: EXISTING_USER, created: false });
      expect(calls.uploads[0].path).toBe("waiver-winner.pdf");
    });

    // With a key, the row is claimed by it: deleting it would break the promise
    // that a retry resolves to the same waiver, and could remove a row another
    // in-flight attempt has already been told about.
    it("keeps the row for a retry when the scan upload fails, rather than deleting it", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        upload: { error: { message: "storage down" } },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, withId, MANAGER_ID),
      ).rejects.toThrow(/same client_submission_id/);
      expect(calls.deletes).toHaveLength(0);
    });

    it("still deletes the half-filed row when there is no key to resume from", async () => {
      const { admin, calls } = fakeAdmin({
        existingId: EXISTING_USER,
        upload: { error: { message: "storage down" } },
      });
      const { filePaperWaiver } = await import("./waiver.functions");
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filePaperWaiver(admin as any, validInput, MANAGER_ID),
      ).rejects.toThrow(/Nothing was filed/);
      expect(calls.deletes).toEqual(["waiver-1"]);
    });

    it("carries the id onto the row so a later retry can find it", async () => {
      const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await filePaperWaiver(admin as any, withId, MANAGER_ID);
      expect((calls.insert[0] as Record<string, unknown>).client_submission_id).toBe(SUBMISSION);
    });

    it("files normally, with a null key, when the caller sends none", async () => {
      const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
      const { filePaperWaiver } = await import("./waiver.functions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await filePaperWaiver(admin as any, validInput, MANAGER_ID);
      expect((calls.insert[0] as Record<string, unknown>).client_submission_id).toBeNull();
    });
  });

  it("looks up the uploader's email for a real user id", async () => {
    const { admin, calls } = fakeAdmin({
      existingId: EXISTING_USER,
      getUserByIdEmail: "manager@example.com",
    });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, MANAGER_ID);
    expect(calls.getUserById).toEqual([MANAGER_ID]);
    const row = calls.insert[0] as Record<string, unknown>;
    const meta = row.signer_meta as Record<string, unknown>;
    expect(meta.uploaded_by_email).toBe("manager@example.com");
  });

  // There is no longer a caller that files a waiver without a real auth user
  // behind it: the manager agent API dropped its environment-key fallback, so
  // every filing names the manager who vouched for the scan. The lookup is
  // therefore attempted every time, and an address it cannot find is a missing
  // decoration, not a filing that skipped the question.
  it("still names the uploader when their address cannot be resolved", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER, getUserByIdEmail: null });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, MANAGER_ID);
    expect(calls.getUserById).toEqual([MANAGER_ID]);
    const row = calls.insert[0] as Record<string, unknown>;
    const meta = row.signer_meta as Record<string, unknown>;
    expect(meta.uploaded_by).toBe(MANAGER_ID);
    expect(meta).not.toHaveProperty("uploaded_by_email");
  });

  it("has no signature, ticks or health answers to store: the scan is the record", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, MANAGER_ID);
    const row = calls.insert[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("signature_image");
    expect(row).not.toHaveProperty("health_answers");
  });
});

/**
 * A PostgREST chain that answers each `from()` with the next queued result.
 *
 * Deliberately order-dependent: `countWaiversAwaitingApproval` makes two reads
 * of the same table (the count, then the newest row), so keying the fake by
 * table name could not tell them apart. The chain is thenable because the count
 * query is awaited directly rather than through `.maybeSingle()`.
 */
type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };

function fakeCountAdmin(results: QueryResult[]) {
  const queue = [...results];
  const tables: string[] = [];
  const filters: Array<[string, unknown]> = [];
  const orders: Array<[string, boolean | undefined]> = [];
  const next = () => queue.shift() ?? { data: null, error: null, count: 0 };
  const admin = {
    from(table: string) {
      tables.push(table);
      const result = next();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters.push([col, value]);
          return chain;
        },
        // Recorded, not swallowed: a fake that ignored this would let
        // `ascending: false` flip to `true` with every test still green, and
        // the item would name whoever signed longest ago.
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push([col, opts?.ascending]);
          return chain;
        },
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (
          onFulfilled?: (value: QueryResult) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, tables, filters, orders };
}

describe("countWaiversAwaitingApproval", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reports nothing waiting without going looking for a name", async () => {
    const { countWaiversAwaitingApproval } = await import("./waiver.functions");
    const { admin, tables } = fakeCountAdmin([{ data: null, error: null, count: 0 }]);
    expect(await countWaiversAwaitingApproval(admin)).toEqual({
      pending: 0,
      latestName: null,
      latestAt: null,
    });
    // One read, not two: with nothing waiting there is no newest signer.
    expect(tables).toEqual(["waivers"]);
  });

  it("names the newest signer the way the waivers screen does", async () => {
    const { countWaiversAwaitingApproval } = await import("./waiver.functions");
    const { admin, filters, orders } = fakeCountAdmin([
      { data: null, error: null, count: 3 },
      {
        data: {
          first_name: "Alexandra",
          middle_name: "",
          last_name: "Nguyen",
          preferred_name: "Alex",
          signed_at: "2026-08-05T10:00:00.000Z",
        },
        error: null,
      },
    ]);
    expect(await countWaiversAwaitingApproval(admin)).toEqual({
      pending: 3,
      latestName: 'Alexandra "Alex" Nguyen',
      latestAt: "2026-08-05T10:00:00.000Z",
    });
    // Both reads ask for the stored fact, and the name comes from the newest
    // signature rather than the oldest one still waiting.
    expect(filters).toEqual([
      ["approval_status", "pending"],
      ["approval_status", "pending"],
    ]);
    expect(orders).toEqual([["signed_at", false]]);
  });

  it("degrades to a bare count when the newest row cannot be read", async () => {
    const { countWaiversAwaitingApproval } = await import("./waiver.functions");
    const { admin } = fakeCountAdmin([
      { data: null, error: null, count: 2 },
      { data: null, error: { message: "boom" } },
    ]);
    // The count is the part the notification cannot do without; a missing name
    // only makes the copy vaguer.
    expect(await countWaiversAwaitingApproval(admin)).toEqual({
      pending: 2,
      latestName: null,
      latestAt: null,
    });
  });

  it("degrades to zero rather than throwing, so one bad read cannot empty the queue", async () => {
    const { countWaiversAwaitingApproval } = await import("./waiver.functions");
    const { admin } = fakeCountAdmin([{ data: null, error: { message: "boom" }, count: null }]);
    // This runs inside the attention list's Promise.all next to the contact
    // messages and the training-dates warning. Throwing here would take those
    // down with it.
    await expect(countWaiversAwaitingApproval(admin)).resolves.toEqual({
      pending: 0,
      latestName: null,
      latestAt: null,
    });
  });
});

// ---- Who a read is allowed to be about ----
//
// `profileForCaller` and `waiversForCaller` were pulled out of their
// `createServerFn` wrappers so the gate inside them is reachable from here.
// That is the whole point: the wrappers die on "No Start context found", so a
// gate left inside one could be deleted with every test still passing.
describe("reading a person other than yourself", () => {
  const PARENT = "bbbbbbbb-0000-4000-8000-000000000001";
  const CHILD = "bbbbbbbb-0000-4000-8000-000000000002";
  const STRANGERS_CHILD = "bbbbbbbb-0000-4000-8000-000000000003";

  const LINKS = [
    { user_id: PARENT, guardian_user_id: null },
    { user_id: CHILD, guardian_user_id: PARENT },
    { user_id: STRANGERS_CHILD, guardian_user_id: "somebody-else" },
  ];

  /** Records which table each read hit and which `user_id` it was filtered to. */
  function readAdmin() {
    const reads: Array<{ table: string; userId: unknown }> = [];
    const admin = {
      from: (table: string) => ({
        select: () => ({
          // The gate's own two-person lookup, which only ever reads `profiles`.
          in: (_c: string, values: string[]) => {
            if (table !== "profiles") throw new Error(`gate read the wrong table: ${table}`);
            return Promise.resolve({
              data: LINKS.filter((r) => values.includes(r.user_id)),
              error: null,
            });
          },
          eq: (_c: string, userId: unknown) => {
            reads.push({ table, userId });
            return {
              maybeSingle: () => Promise.resolve({ data: { user_id: userId }, error: null }),
              order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
            };
          },
        }),
      }),
    };
    return { admin: admin as unknown as SupabaseClient<Database>, reads };
  }

  it("reads the caller's own row when no target is named", async () => {
    const { profileForCaller } = await import("./waiver.functions");
    const { admin, reads } = readAdmin();
    await profileForCaller(admin, PARENT, undefined);
    expect(reads).toEqual([{ table: "profiles", userId: PARENT }]);
  });

  it("reads a dependant's rows for their own guardian", async () => {
    const { profileForCaller, waiversForCaller } = await import("./waiver.functions");

    const profile = readAdmin();
    await profileForCaller(profile.admin, PARENT, CHILD);
    expect(profile.reads).toEqual([{ table: "profiles", userId: CHILD }]);

    const waivers = readAdmin();
    await waiversForCaller(waivers.admin, PARENT, CHILD);
    expect(waivers.reads).toEqual([{ table: "waivers", userId: CHILD }]);
  });

  // Without the gate these hand back somebody else's medical notes and waiver
  // history. Asserting `reads` is empty is the part that matters: the refusal
  // happens before anything is fetched at all.
  it("refuses somebody else's dependant, and reads NOTHING", async () => {
    const { profileForCaller, waiversForCaller } = await import("./waiver.functions");

    const profile = readAdmin();
    await expect(profileForCaller(profile.admin, PARENT, STRANGERS_CHILD)).rejects.toThrow(
      /only see or change your own account/i,
    );
    expect(profile.reads).toEqual([]);

    const waivers = readAdmin();
    await expect(waiversForCaller(waivers.admin, PARENT, STRANGERS_CHILD)).rejects.toThrow(
      /only see or change your own account/i,
    );
    expect(waivers.reads).toEqual([]);
  });
});

// ---- Filing for somebody on an account (#105) ----
//
// The paper path is used to exercise this because it is the one that takes an
// admin client as a parameter; `submitWaiverWithPdf` is a `createServerFn`
// handler and dies on "No Start context found" from the runner.
//
// ⚠️ So what is proved here is `resolveDependantId` and `findDependantId`, which
// both paths share, and NOT the public form's own wiring around them. The order
// there (resolve the guardian, then the sign-in gate, then create the child),
// the `contactId`-vs-`userId` split across the verification stamp, the
// confirmation email and the ban check, and the suppressed code-of-conduct
// token are covered by nothing in this file. Deleting the gate in
// `submitWaiverWithPdf` keeps this suite green. That gap belongs to the
// end-to-end suite, which drives the real form.
describe("filePaperWaiver, for a dependant", () => {
  const PARENT = EXISTING_USER;

  /** A child's filing: no address of their own, the guardian named. */
  const dependantInput = (over: Partial<PaperWaiverUploadInput> = {}): PaperWaiverUploadInput => ({
    ...validInput,
    signing_for: "dependant",
    email: "",
    guardian_email: "parent@example.com",
    guardian_name: "Charles Babbage",
    guardian_relationship: "Father",
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: "2016-03-02",
    ...over,
  });

  it("files against a new dependant with a reserved address, banned and unconfirmed", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin, calls, profiles } = fakeAdmin({
      // The parent is already on the books, so only the child is created.
      existingId: PARENT,
      profiles: [{ user_id: PARENT, guardian_user_id: null }],
      mintedUserIds: [CHILD_ONE],
    });

    const result = await filePaperWaiver(admin, dependantInput(), MANAGER_ID);

    expect(result.user_id).toBe(CHILD_ONE);
    expect(result.user_id).not.toBe(PARENT);

    // Exactly one auth user was made, and it is the child's.
    expect(calls.createUser).toHaveLength(1);
    const created = calls.createUser[0] as {
      email: string;
      email_confirm: boolean;
      ban_duration: string;
    };
    // The address carries a uuid and nothing about the child. Proven against
    // real GoTrue before any of this was written: see the note on
    // DEPENDANT_EMAIL_DOMAIN.
    expect(created.email).toMatch(/^[0-9a-f-]{36}@dependant\.jitsu\.au$/i);
    // Never confirmed and never able to sign in. A dependant is not an
    // applicant waiting on approval; the ban is the permanent state.
    expect(created.email_confirm).toBe(false);
    expect(created.ban_duration).toBe("876000h");

    // ...and the one column that actually makes them a dependant.
    expect(profiles.get(CHILD_ONE)?.guardian_user_id).toBe(PARENT);
  });

  it("creates the parent's own person record when this is their first child", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    // The club has never seen this address, so BOTH people are new.
    const { admin, calls, profiles } = fakeAdmin({
      existingId: null,
      mintedUserIds: [NEW_USER, CHILD_ONE],
    });

    const result = await filePaperWaiver(admin, dependantInput(), MANAGER_ID);

    expect(calls.createUser).toHaveLength(2);
    // The parent first, under the address that was typed, and the child second
    // under a reserved one.
    expect((calls.createUser[0] as { email: string }).email).toBe("parent@example.com");
    expect((calls.createUser[1] as { email: string }).email).toMatch(/@dependant\.jitsu\.au$/);
    expect(result.user_id).toBe(CHILD_ONE);
    expect(profiles.get(CHILD_ONE)?.guardian_user_id).toBe(NEW_USER);
    // The parent's record is seeded from the GUARDIAN block, not the child's
    // name. Seeding a parent's profile with their nine-year-old's details is
    // the same "two people, one record" bug one level up.
    expect(profiles.get(NEW_USER)?.first_name).toBe("Charles");
    expect(profiles.get(NEW_USER)?.last_name).toBe("Babbage");
  });

  // The case #102 is about, and the one that would have failed before this
  // change: two children on one parent's address used to resolve to ONE person.
  it("gives two children on one parent email two distinct person records", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin, profiles } = fakeAdmin({
      existingId: PARENT,
      profiles: [{ user_id: PARENT, guardian_user_id: null }],
      mintedUserIds: [CHILD_ONE, CHILD_TWO],
    });

    const first = await filePaperWaiver(
      admin,
      dependantInput({
        first_name: "Ada",
        date_of_birth: "2016-03-02",
        client_submission_id: "11111111-1111-4111-8111-111111111111",
      }),
      MANAGER_ID,
    );
    const second = await filePaperWaiver(
      admin,
      dependantInput({
        first_name: "Grace",
        date_of_birth: "2018-07-11",
        client_submission_id: "22222222-2222-4222-8222-222222222222",
        confirm_duplicate: true,
      }),
      MANAGER_ID,
    );

    expect(first.user_id).toBe(CHILD_ONE);
    expect(second.user_id).toBe(CHILD_TWO);
    expect(first.user_id).not.toBe(second.user_id);
    // Neither is the parent, and both hang off them.
    expect(first.user_id).not.toBe(PARENT);
    expect(second.user_id).not.toBe(PARENT);
    expect(profiles.get(CHILD_ONE)?.guardian_user_id).toBe(PARENT);
    expect(profiles.get(CHILD_TWO)?.guardian_user_id).toBe(PARENT);
  });

  it("does not attach a second child to the first", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    // Ada is already on the account. Grace is not.
    const { admin, calls } = fakeAdmin({
      existingId: PARENT,
      profiles: [
        { user_id: PARENT, guardian_user_id: null },
        {
          user_id: CHILD_ONE,
          guardian_user_id: PARENT,
          first_name: "Ada",
          last_name: "Lovelace",
          date_of_birth: "2016-03-02",
        },
      ],
      mintedUserIds: [CHILD_TWO],
    });

    const result = await filePaperWaiver(
      admin,
      dependantInput({ first_name: "Grace", date_of_birth: "2018-07-11" }),
      MANAGER_ID,
    );

    expect(result.user_id).toBe(CHILD_TWO);
    expect(result.user_id).not.toBe(CHILD_ONE);
    expect(calls.createUser).toHaveLength(1);
  });

  // The other half of that rule, and the reason matching beats always-creating:
  // one child signed for twice is one person, not two with two free trials.
  it("re-uses the same child on a second waiver, matching name and date of birth", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin, calls } = fakeAdmin({
      existingId: PARENT,
      profiles: [
        { user_id: PARENT, guardian_user_id: null },
        {
          user_id: CHILD_ONE,
          guardian_user_id: PARENT,
          first_name: "Ada",
          last_name: "Lovelace",
          date_of_birth: "2016-03-02",
        },
      ],
    });

    const result = await filePaperWaiver(
      admin,
      // Typed back with different capitalisation and stray spacing, the way a
      // second filing realistically arrives.
      dependantInput({ first_name: "  ada  ", last_name: "LOVELACE" }),
      MANAGER_ID,
    );

    expect(result.user_id).toBe(CHILD_ONE);
    // Nobody new was minted: not the parent, who already exists, and not the
    // child, who was matched.
    expect(calls.createUser).toHaveLength(0);
  });

  // The one-level rule, which the migration deliberately left to the
  // application because a depth check in SQL needs a trigger.
  it("refuses to hang a dependant off another dependant", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin, calls } = fakeAdmin({
      existingId: CHILD_ONE,
      profiles: [
        { user_id: PARENT, guardian_user_id: null },
        { user_id: CHILD_ONE, guardian_user_id: PARENT },
      ],
    });

    await expect(filePaperWaiver(admin, dependantInput(), MANAGER_ID)).rejects.toThrow(
      /only see or change your own account/i,
    );
    // Nothing was created on the way to refusing.
    expect(calls.createUser).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });

  // A dependant's filing has to probe the CHILD's waivers, not the parent's.
  // #105 says this probe "keeps working, because a child now has their own user
  // id"; it only does because the participant is resolved read-only first.
  // Without that, two scans of one child's form would both file in silence.
  it("checks the child's own waivers for a duplicate, not the parent's", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin } = fakeAdmin({
      existingId: PARENT,
      profiles: [
        { user_id: PARENT, guardian_user_id: null },
        {
          user_id: CHILD_ONE,
          guardian_user_id: PARENT,
          first_name: "Ada",
          last_name: "Lovelace",
          date_of_birth: "2016-03-02",
        },
      ],
      duplicates: ok([
        { id: "waiver-0", approval_status: "pending", signed_at: "2020-01-15T00:00:00+00:00" },
      ]),
    });

    const { DuplicateWaiverError } = await import("./waiver-duplicates");
    await expect(filePaperWaiver(admin, dependantInput(), MANAGER_ID)).rejects.toBeInstanceOf(
      DuplicateWaiverError,
    );
  });

  it("skips the duplicate probe for a child the club has never seen", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    // The parent exists and has waivers of their own on this date. The child
    // does not exist yet, so there is nothing of THEIRS to collide with, and
    // the parent's must not be mistaken for it.
    const { admin } = fakeAdmin({
      existingId: PARENT,
      profiles: [{ user_id: PARENT, guardian_user_id: null }],
      mintedUserIds: [CHILD_ONE],
      duplicates: ok([
        { id: "waiver-0", approval_status: "pending", signed_at: "2020-01-15T00:00:00+00:00" },
      ]),
    });

    const result = await filePaperWaiver(admin, dependantInput(), MANAGER_ID);
    expect(result.user_id).toBe(CHILD_ONE);
  });

  // The orphan case. The ensure_profile trigger creates the profile row the
  // moment the auth user exists, so a failed guardian link leaves a nameless
  // person on a reserved address that no screen can find or fix. Throwing tells
  // the signer; removing the auth user is what takes the record back off the
  // books.
  it("removes the half-created dependant when the guardian link fails", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, calls, profiles } = fakeAdmin({
      existingId: PARENT,
      profiles: [{ user_id: PARENT, guardian_user_id: null }],
      mintedUserIds: [CHILD_ONE],
      profileUpsert: fails("guardian_user_id violates foreign key"),
    });

    await expect(filePaperWaiver(admin, dependantInput(), MANAGER_ID)).rejects.toThrow(
      /couldn't add that person/i,
    );
    expect(calls.deleteUser).toEqual([CHILD_ONE]);
    expect(profiles.has(CHILD_ONE)).toBe(false);
    // And no waiver was filed against the person that never finished existing.
    expect(calls.insert).toHaveLength(0);
  });

  it("files the waiver under the guardian's address, as the frozen record", async () => {
    const { filePaperWaiver } = await import("./waiver.functions");
    const { admin, calls } = fakeAdmin({
      existingId: PARENT,
      profiles: [{ user_id: PARENT, guardian_user_id: null }],
      mintedUserIds: [CHILD_ONE],
    });

    await filePaperWaiver(admin, dependantInput(), MANAGER_ID);

    const row = calls.insert[0] as { email: string; user_id: string; guardian_email: string };
    // What was typed on the form, which is honestly the only address anyone
    // gave. A blank would be worse for whoever reads this in a year, and the
    // child's reserved one appears nowhere.
    expect(row.email).toBe("parent@example.com");
    expect(row.guardian_email).toBe("parent@example.com");
    expect(row.user_id).toBe(CHILD_ONE);
  });
});

// The one thing on the public signing page that is not public. Filing for a
// dependant writes a new person into somebody else's household, which an
// anonymous submission naming a member's address must not be able to do.
describe("needsSignInToFileForDependant", () => {
  const HOUR = 60 * 60 * 1000;
  const now = new Date("2026-08-31T00:00:00.000Z");
  const banned = new Date(now.getTime() + HOUR).toISOString();
  const expired = new Date(now.getTime() - HOUR).toISOString();

  it("refuses an anonymous signer against a guardian who can already sign in", async () => {
    const { needsSignInToFileForDependant } = await import("./waiver.functions");
    expect(
      needsSignInToFileForDependant({
        identityProven: false,
        guardianBannedUntil: null,
        now,
      }),
    ).toBe(true);
    // A ban that has run out is not a ban.
    expect(
      needsSignInToFileForDependant({
        identityProven: false,
        guardianBannedUntil: expired,
        now,
      }),
    ).toBe(true);
  });

  // The flow this must not break, and the whole point of the feature: a parent
  // with no account signs for their first child, and approving that waiver is
  // what gives them a login. They cannot sign in, so a refusal would be
  // unactionable and the feature unreachable.
  it("allows an anonymous signer against a guardian who is still locked", async () => {
    const { needsSignInToFileForDependant } = await import("./waiver.functions");
    expect(
      needsSignInToFileForDependant({
        identityProven: false,
        guardianBannedUntil: banned,
        now,
      }),
    ).toBe(false);
  });

  it("never asks anything of a signer who has proved who they are", async () => {
    const { needsSignInToFileForDependant } = await import("./waiver.functions");
    for (const guardianBannedUntil of [null, banned, expired]) {
      expect(
        needsSignInToFileForDependant({ identityProven: true, guardianBannedUntil, now }),
      ).toBe(false);
    }
  });
});
