import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managerAgentActions } from "@/lib/validation";
import { CHANGE_ACTIONS, READ_ACTIONS, isReadAction } from "./actions";
import manifestTool from "./tools/manifest";
import readTool from "./tools/read";
import changeTool from "./tools/change";

describe("MCP action split", () => {
  it("covers every manager agent action exactly once", () => {
    expect([...READ_ACTIONS, ...CHANGE_ACTIONS].sort()).toEqual([...managerAgentActions].sort());
  });

  it("keeps every action that writes or emails off the read-only tool", () => {
    for (const action of [
      "create_membership",
      "edit_invoice",
      "mark_invoice_paid",
      "delete_invoice",
      "file_waiver",
      "publish_waiver_template",
      "create_item_invoice",
      "delete_item",
      "save_blog_post",
      "delete_blog_post",
      "upload_blog_image",
      "mark_contact_messages_seen",
      "delete_contact_message",
    ]) {
      expect(READ_ACTIONS).not.toContain(action);
      expect(CHANGE_ACTIONS).toContain(action);
    }
  });

  it("treats list_ and get_ actions as reads", () => {
    expect(READ_ACTIONS).toContain("list_users");
    expect(READ_ACTIONS).toContain("get_club_settings");
    expect(READ_ACTIONS).toContain("list_blog_posts");
    expect(READ_ACTIONS).toContain("get_blog_post");
    expect(READ_ACTIONS).toContain("list_contact_messages");
    expect(isReadAction("save_item")).toBe(false);
  });
});

// `.lovable/mcp/manifest.json` is what the Lovable platform reads to publish the
// tool list, and it is only rewritten by Lovable's own commit pipeline. An
// action added from anywhere else would leave the published `club_read` /
// `club_change` enums without it, so an assistant could never call it, while
// every other check stayed green. The same goes for a reworded tool, whose old
// description would keep steering assistants. What this does not compare is
// the params' JSON Schema, beyond the action lists.
describe("published MCP manifest", () => {
  type ManifestTool = {
    name: string;
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema: { properties?: { action?: { enum?: string[] } } };
  };
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../.lovable/mcp/manifest.json"), "utf8"),
  ) as { mcp: { tools: ManifestTool[] } };
  const actionsOf = (name: string) =>
    manifest.mcp.tools.find((t) => t.name === name)?.inputSchema.properties?.action?.enum;
  const stale = "is stale: run `bunx lovable-mcp-extract-manifest` and commit the result";

  it("publishes the three tools", () => {
    expect(manifest.mcp.tools.map((t) => t.name).sort(), `the manifest ${stale}`).toEqual([
      "club_change",
      "club_manifest",
      "club_read",
    ]);
  });

  it("publishes each tool as the code defines it", () => {
    for (const tool of [manifestTool, readTool, changeTool]) {
      const published = manifest.mcp.tools.find((t) => t.name === tool.name);
      expect(
        {
          title: published?.title,
          description: published?.description,
          annotations: published?.annotations,
        },
        `${tool.name} in the manifest ${stale}`,
      ).toEqual({
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
      });
    }
  });

  it("publishes exactly the actions the code splits into each tool", () => {
    expect(actionsOf("club_read"), `club_read in the manifest ${stale}`).toEqual([...READ_ACTIONS]);
    expect(actionsOf("club_change"), `club_change in the manifest ${stale}`).toEqual([
      ...CHANGE_ACTIONS,
    ]);
  });
});
