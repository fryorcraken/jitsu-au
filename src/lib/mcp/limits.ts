// How big a request the MCP server accepts.
//
// @lovable.dev/mcp-js refuses any request body over 1 MiB with a 413 unless
// `defineMcp` says otherwise, before the tool ever runs. Our largest inputs are
// files sent inline as base64: a paper waiver's scans (`file_waiver`) and a
// blog picture (`upload_blog_image`). At 1 MiB those failed over MCP from about
// 750 KB of file, while the same call to /api/manager/agent, which has no such
// cap, went through, and the two doors are meant to behave identically
// (docs/manager-agent-api.md). So the cap follows the actions' own limits
// instead: base64 is 4/3 of the bytes it carries, plus room for the rest of
// the call. An oversized file is still refused, by the action's validation,
// in the same words over both doors.
import { MAX_BLOG_IMAGE_BYTES, MAX_SCAN_BYTES } from "@/lib/validation";

const LARGEST_FILE_BYTES = Math.max(MAX_SCAN_BYTES, MAX_BLOG_IMAGE_BYTES);
const ENVELOPE_BYTES = 1024 * 1024;

export const MAX_MCP_REQUEST_BODY_BYTES = Math.ceil((LARGEST_FILE_BYTES * 4) / 3) + ENVELOPE_BYTES;
