// The club's MCP server: the manager agent API, reachable from Claude Code,
// Claude, Cursor and other assistants by signing in with a club account.
// See docs/manager-agent-api.md, "MCP server".
import { auth, defineMcp } from "@lovable.dev/mcp-js";
import manifestTool from "./tools/manifest";
import readTool from "./tools/read";
import changeTool from "./tools/change";

// Vite inlines the stable project ref; the published SUPABASE_URL may be a proxy,
// and the token issuer must be the direct address.
const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

export default defineMcp({
  name: "jitsu-club-management",
  title: "Jitsu Club Management",
  version: "0.1.0",
  instructions:
    "Back-office tools for managers of UTS Jitsu, a Sydney jiu-jitsu club. Call club_manifest first: it lists every action and its params. Use club_read for lookups and club_change for anything that writes. Confirm the member's name and any amount with the manager before a change, because many changes email the member. Only club managers can use these tools.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
    requireOAuthClientClaim: true,
  }),
  tools: [manifestTool, readTool, changeTool],
});
