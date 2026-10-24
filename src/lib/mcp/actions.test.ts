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
      "save_blog_post",
      "delete_blog_post",
      "upload_blog_image",
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
    expect(isReadAction("save_item")).toBe(false);
  });
});
