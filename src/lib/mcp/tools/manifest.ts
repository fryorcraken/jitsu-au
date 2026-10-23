import { defineTool } from "@lovable.dev/mcp-js";
import { AGENT_MANIFEST } from "@/lib/manager-agent";
import { requireManager } from "../run-action";

export default defineTool({
  name: "club_manifest",
  title: "List club manager actions",
  description:
    "Read the full list of club manager actions, what each one does and the params it takes. Call this first, then use club_read or club_change.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    await requireManager(ctx);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, ...AGENT_MANIFEST }, null, 2) }],
    };
  },
});
