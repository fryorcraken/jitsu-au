// A saved waiver must never be reported as a failure.
//
// `submitWaiverWithPdf` used to throw when the PDF could not be rendered,
// uploaded, or signed — after the waiver row was already committed. The person
// who had just signed saw an error, and the reliable thing they do next is sign
// again. Everything past the insert now degrades to `pdf_ready: false` instead,
// and `signStoredPdf` is the helper every one of those paths leans on.
//
// It is testable because it takes its client as a parameter. The handlers around
// it are `createServerFn` handlers, which die on "No Start context found in
// AsyncLocalStorage" when called from the runner (see membership.functions.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
