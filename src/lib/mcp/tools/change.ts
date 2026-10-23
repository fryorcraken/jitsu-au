import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { CHANGE_ACTIONS } from "../actions";
import { runAgentAction } from "../run-action";

export default defineTool({
  name: "club_change",
  title: "Change club records",
  description:
    "Run a club manager action that changes something, such as create_membership or mark_invoice_paid. Many of these email a member, and some cannot be undone, so confirm the person and the amount with the manager first. See club_manifest for each action's params.",
  inputSchema: {
    action: z.enum(CHANGE_ACTIONS).describe("The action to run."),
    params: z
      .record(z.unknown())
      .optional()
      .describe("The action's params, exactly as club_manifest lists them."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: ({ action, params }, ctx) => runAgentAction(ctx, action, params),
});
