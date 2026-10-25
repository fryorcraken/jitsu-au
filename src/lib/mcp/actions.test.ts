import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managerAgentActions } from "@/lib/validation";
import { CHANGE_ACTIONS, READ_ACTIONS, isReadAction } from "./actions";

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
    ]) {
      expect(READ_ACTIONS).not.toContain(action);
      expect(CHANGE_ACTIONS).toContain(action);
    }
  });

  it("treats list_ and get_ actions as reads", () => {
    expect(READ_ACTIONS).toContain("list_users");
    expect(READ_ACTIONS).toContain("get_club_settings");
    expect(isReadAction("save_item")).toBe(false);
  });
});

// `.lovable/mcp/manifest.json` is what the Lovable platform reads to publish the
// tool list, and it is only rewritten by Lovable's own commit pipeline. An
// action added from anywhere else would leave the published `club_read` /
// `club_change` enums without it, so an assistant could never call it, while
// every other check stayed green.
describe("published MCP manifest", () => {
  type ManifestTool = {
    name: string;
    inputSchema: { properties?: { action?: { enum?: string[] } } };
  };
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), ".lovable/mcp/manifest.json"), "utf8"),
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

  it("publishes exactly the actions the code splits into each tool", () => {
    expect(actionsOf("club_read"), `club_read in the manifest ${stale}`).toEqual([...READ_ACTIONS]);
    expect(actionsOf("club_change"), `club_change in the manifest ${stale}`).toEqual([
      ...CHANGE_ACTIONS,
    ]);
  });
});
