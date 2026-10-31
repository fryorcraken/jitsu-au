import { describe, expect, it } from "vitest";
import { ID_CHUNK, chunks } from "./id-chunks";

describe("chunks", () => {
  it("gives nothing for nothing", () => {
    expect(chunks([])).toEqual([]);
  });

  it("keeps a short list whole", () => {
    expect(chunks(["a", "b"])).toEqual([["a", "b"]]);
  });

  // The limit is the point: one id past it has to start a second request.
  it("starts a new slice one past the limit, keeping every id in order", () => {
    const ids = Array.from({ length: ID_CHUNK * 2 + 1 }, (_, i) => i);
    const sliced = chunks(ids);
    expect(sliced.map((s) => s.length)).toEqual([ID_CHUNK, ID_CHUNK, 1]);
    expect(sliced.flat()).toEqual(ids);
  });
});
