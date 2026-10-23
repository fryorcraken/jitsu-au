// The one path from an MCP tool call into the manager agent API.
//
// The HTTP endpoint authenticates a minted manager token; this authenticates an
// OAuth sign-in instead, and then runs the SAME dispatch, so an action called
// over MCP and one POSTed to /api/manager/agent cannot behave differently.
//
// Order matters. The manager check runs as the signed-in person (their own
// token, RLS applies) before anything touches the service-role code behind
// `dispatch`. The person acting is always the verified token's subject, never
// anything in the tool input, so every row written names a real manager.
import { ToolError, type ToolContext } from "@lovable.dev/mcp-js";
import { AGENT_MANIFEST } from "@/lib/manager-agent";
import { dispatch, errorResponse } from "@/lib/manager-agent-actions";
import type { ManagerAgentAction } from "@/lib/validation";
import { supabaseForUser } from "./supabase";

async function requireManagerCaller(ctx: ToolContext): Promise<string> {
  const userId = ctx.getUserId();
  if (!userId) throw new ToolError("Sign in to the club site to use these tools.");
  const { data: isManager, error } = await supabaseForUser(ctx).rpc("has_role", {
    _user_id: userId,
    _role: "manager",
  });
  if (error) {
    console.error("[mcp] manager check failed:", error.message);
    throw new ToolError("Could not check your manager access just now. Try again shortly.");
  }
  if (!isManager) {
    throw new ToolError(
      "These tools are for club managers, and the account you connected with is not one.",
    );
  }
  return userId;
}

export async function requireManager(ctx: ToolContext): Promise<void> {
  await requireManagerCaller(ctx);
}

export async function runAgentAction(
  ctx: ToolContext,
  action: ManagerAgentAction,
  params: Record<string, unknown> | undefined,
) {
  const actingAs = await requireManagerCaller(ctx);
  try {
    const result = await dispatch(action, params ?? {}, actingAs);
    const body = { ok: true, version: AGENT_MANIFEST.version, action, result };
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  } catch (e) {
    // Reuse the HTTP endpoint's error shaping, so a refusal reads the same over
    // both doors and a database error's internal text never leaves the server.
    const body = await errorResponse(e).text();
    return { isError: true, content: [{ type: "text" as const, text: body }] };
  }
}
