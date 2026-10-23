// Which manager agent actions only read, and which change something.
//
// The MCP server exposes the manager agent API as two tools rather than one, so
// an assistant can be told (and can tell its user) which calls are safe to run
// without asking. A read is anything named list_* or get_*; everything else
// writes, emails somebody, or both. Kept pure so the split is unit-tested: a
// new action lands on the CHANGE side by default unless its name says it reads.
import { managerAgentActions, type ManagerAgentAction } from "@/lib/validation";

export function isReadAction(action: string): boolean {
  return action.startsWith("list_") || action.startsWith("get_");
}

type ActionTuple = [ManagerAgentAction, ...ManagerAgentAction[]];

export const READ_ACTIONS = managerAgentActions.filter(isReadAction) as ActionTuple;
export const CHANGE_ACTIONS = managerAgentActions.filter((a) => !isReadAction(a)) as ActionTuple;
