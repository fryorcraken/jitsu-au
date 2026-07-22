import { describe, expect, it } from "vitest";
import {
  API_TOKEN_PREFIX,
  buildAgentPrompt,
  generateRawToken,
  hashToken,
  tokenPreview,
} from "./manager-api-tokens";
import { createApiTokenSchema, revokeApiTokenSchema } from "./validation";

describe("generateRawToken", () => {
  it("is prefixed and has 24 bytes (48 hex chars) of entropy", () => {
    const t = generateRawToken();
    expect(t.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(t.slice(API_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("produces distinct tokens", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateRawToken()));
    expect(seen.size).toBe(50);
  });
});

describe("hashToken", () => {
  it("is a stable 64-char sha-256 hex digest", async () => {
    const a = await hashToken("utsj_deadbeef");
    const b = await hashToken("utsj_deadbeef");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs and never echoes the raw token", async () => {
    const raw = generateRawToken();
    const h = await hashToken(raw);
    expect(h).not.toBe(await hashToken(generateRawToken()));
    expect(h).not.toContain(raw);
  });
});

describe("tokenPreview", () => {
  it("keeps the prefix plus 8 chars and drops the secret tail", () => {
    const raw = `${API_TOKEN_PREFIX}0123456789abcdef`;
    expect(tokenPreview(raw)).toBe(`${API_TOKEN_PREFIX}01234567`);
    expect(tokenPreview(raw).length).toBe(API_TOKEN_PREFIX.length + 8);
  });
});

describe("buildAgentPrompt", () => {
  it("embeds the endpoint, keeps the token in an env var, and points at the manifest", () => {
    const prompt = buildAgentPrompt({ baseUrl: "https://jitsu.au/" });
    expect(prompt).toContain("https://jitsu.au/api/manager/agent");
    // trailing slash normalized (no double slash)
    expect(prompt).not.toContain("jitsu.au//api");
    expect(prompt).toContain("$UTS_MANAGER_API_KEY");
    expect(prompt).toContain("read the manifest");
    expect(prompt).toContain("edit_invoice");
  });
});

describe("token schemas", () => {
  it("createApiTokenSchema requires a non-empty label", () => {
    expect(createApiTokenSchema.parse({ label: "laptop" }).label).toBe("laptop");
    expect(() => createApiTokenSchema.parse({ label: "" })).toThrow();
    expect(() => createApiTokenSchema.parse({ label: "  " })).toThrow();
  });

  it("revokeApiTokenSchema requires a uuid", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(revokeApiTokenSchema.parse({ id }).id).toBe(id);
    expect(() => revokeApiTokenSchema.parse({ id: "nope" })).toThrow();
  });
});
