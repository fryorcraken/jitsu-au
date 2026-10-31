import { describe, expect, it } from "vitest";
import { requestHeaderGetter } from "./request-headers";

describe("requestHeaderGetter", () => {
  it("answers undefined outside a request rather than throwing", async () => {
    // A rate limit or a forensic IP read from a unit test, a script, or any
    // code path with no request behind it must degrade to "no address".
    const getHeader = await requestHeaderGetter();
    expect(getHeader("cf-connecting-ip")).toBeUndefined();
  });
});
