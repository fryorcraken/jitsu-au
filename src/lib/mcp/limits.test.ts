import { describe, expect, it } from "vitest";
import { MAX_BLOG_IMAGE_BYTES, MAX_SCAN_BYTES } from "@/lib/validation";
import mcp from "./index";
import { MAX_MCP_REQUEST_BODY_BYTES } from "./limits";

/** A club_change call as an MCP client sends it, carrying `files` as base64. */
function toolCallBody(params: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "club_change", arguments: params },
  });
}

/** Base64 for `bytes` decoded bytes, split across `count` files. */
function base64Files(bytes: number, count: number, type: string) {
  const each = Math.floor(bytes / count);
  return Array.from({ length: count }, (_, i) => ({
    name: `scan-${i + 1}.jpg`,
    type,
    data: Buffer.alloc(each, 0xff).toString("base64"),
  }));
}

describe("the MCP request size limit", () => {
  // At the library's default of 1 MiB a waiver scan over about 750 KB was
  // refused over MCP and accepted over HTTP.
  it("is set on the server, above the library's 1 MiB default", () => {
    expect(mcp.limits?.maxRequestBodySize).toBe(MAX_MCP_REQUEST_BODY_BYTES);
    expect(MAX_MCP_REQUEST_BODY_BYTES).toBeGreaterThan(1024 * 1024);
  });

  it("takes a paper waiver with as much scan as the action allows", () => {
    const body = toolCallBody({
      action: "file_waiver",
      params: {
        first_name: "Example",
        last_name: "Person",
        email: "person@example.com",
        signed_on: "2026-10-30",
        scan: base64Files(MAX_SCAN_BYTES, 20, "image/jpeg"),
      },
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_MCP_REQUEST_BODY_BYTES);
  });

  it("takes a blog picture as large as the action allows", () => {
    const [image] = base64Files(MAX_BLOG_IMAGE_BYTES, 1, "image/jpeg");
    const body = toolCallBody({
      action: "upload_blog_image",
      params: { name: image.name, type: image.type, data: image.data },
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_MCP_REQUEST_BODY_BYTES);
  });
});
