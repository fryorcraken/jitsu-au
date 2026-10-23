import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { READ_ACTIONS } from "../actions";
import { runAgentAction } from "../run-action";

export default defineTool({
  name: "club_read",
  title: "Look something up",
  description:
    "Run a read-only club manager action, such as list_users or list_invoices. Nothing is changed and nobody is emailed. See club_manifest for each action's params.",
  inputSchema: {
    action: z.enum(READ_ACTIONS).describe("The read-only action to run."),
    params: z
      .record(z.unknown())
      .optional()
      .describe("The action's params, exactly as club_manifest lists them."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ action, params }, ctx) => runAgentAction(ctx, action, params),
});
