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

/** A service-role stub covering exactly the one storage chain the helper walks. */
function fakeAdmin(result: SignResult | (() => never)) {
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
    const { admin, calls } = fakeAdmin({
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
    const { admin, calls } = fakeAdmin({ data: null, error: null });

    await expect(signStoredPdf(admin, null)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("swallows a storage error rather than failing a signed waiver", async () => {
    const { signStoredPdf } = await import("./waiver.functions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ data: null, error: { message: "Object not found" } });

    await expect(signStoredPdf(admin, "w1.pdf")).resolves.toBeNull();
  });

  it("swallows a thrown storage failure too", async () => {
    // Storage can reject outright (a network fault inside the SDK), not just
    // return an error object. Both must come back as "no link", never as a throw
    // that would be reported to the signer as a failed submission.
    const { signStoredPdf } = await import("./waiver.functions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(signStoredPdf(admin, "w1.pdf")).resolves.toBeNull();
  });
});

type Result = { data: unknown; error: { message: string } | null };
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
function fakeAdmin(opts: {
  existingId?: string | null;
  createUser?: Result;
  insert?: Result;
  upload?: { error: { message: string } | null };
  delete?: { error: { message: string } | null };
  pdfPathUpdate?: { error: { message: string } | null };
  remove?: { error: { message: string } | null };
  getUserByIdEmail?: string | null;
}) {
  const inserted = opts.insert ?? ok({ id: "waiver-1" });
  const upload = opts.upload ?? { error: null };
  const del = opts.delete ?? { error: null };
  const pdfPathUpdate = opts.pdfPathUpdate ?? { error: null };
  const remove = opts.remove ?? { error: null };

  const calls = {
    rpc: [] as string[],
    createUser: [] as unknown[],
    upsert: [] as unknown[],
    insert: [] as unknown[],
    updates: [] as unknown[],
    deletes: [] as string[],
    uploads: [] as { path: string; bytes: unknown }[],
    removes: [] as string[][],
    getUserById: [] as string[],
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
          return Promise.resolve(
            opts.createUser ?? ok({ user: { id: NEW_USER } }),
          ) as unknown as Promise<{ data: { user: { id: string } | null }; error: unknown }>;
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
          upsert: (row: unknown) => {
            calls.upsert.push(row);
            return Promise.resolve(ok(null));
          },
        };
      }
      if (table === "waivers") {
        return {
          insert: (row: unknown) => {
            calls.insert.push(row);
            return { select: () => ({ single: () => Promise.resolve(inserted) }) };
          },
          update: (patch: unknown) => {
            calls.updates.push(patch);
            return { eq: () => Promise.resolve(pdfPathUpdate) };
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

  return { admin, calls };
}

const validInput: PaperWaiverUploadInput = {
  first_name: "Ada",
  middle_name: "",
  last_name: "Lovelace",
  preferred_name: "",
  date_of_birth: "1990-12-10",
  address: "1 Broadway, Ultimo NSW",
  phone: "0400000000",
  email: "Ada@Example.com",
  uts_student_number: "",
  sms_whatsapp_consent: false,
  emergency_contact_name: "Charles Babbage",
  emergency_contact_relationship: "Colleague",
  emergency_contact_phone: "0400000001",
  medical_notes: "",
  signed_on: "2020-01-15",
  template_version: 3,
  scan: [{ name: "waiver.pdf", type: "application/pdf", data: "aGlw" }],
};

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

    expect(result).toEqual({ id: "waiver-1", user_id: EXISTING_USER });
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
    expect(row.guardian_name).toBe("Charles Babbage");
    expect(row.guardian_relationship).toBe("Colleague");
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

  it("skips the uploader lookup for a non-UUID caller (the agent API's break-glass key)", async () => {
    const { admin, calls } = fakeAdmin({ existingId: EXISTING_USER });
    const { filePaperWaiver } = await import("./waiver.functions");
    const { AGENT_ENV_KEY_UPLOADER } = await import("./manager-agent");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await filePaperWaiver(admin as any, validInput, AGENT_ENV_KEY_UPLOADER);
    expect(calls.getUserById).toEqual([]);
    const row = calls.insert[0] as Record<string, unknown>;
    const meta = row.signer_meta as Record<string, unknown>;
    expect(meta.uploaded_by).toBe(AGENT_ENV_KEY_UPLOADER);
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
