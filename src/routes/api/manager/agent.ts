// Manager agent HTTP API — a small, token-authenticated JSON surface a manager's
// AI agent can drive (via an MCP wrapper or the uts-manager-agent skill).
//
//   GET  /api/manager/agent   -> the self-describing manifest (source of truth)
//   POST /api/manager/agent   -> { action, params } dispatch
//
// Auth is an opaque bearer token rather than a manager's Supabase JWT: agents
// can't run the email/password login flow, and this endpoint only ever exposes
// the whitelisted manager actions below. A minted, hashed manager_api_tokens row
// is the ONLY thing that authenticates here — there is no environment-variable
// fallback, so every request resolves to a named manager who still holds the
// role today, and losing a token means minting another at /manager/api-tokens.
// All DB access uses the service-role admin client, so it is lazy-imported
// inside the handler (route files are bundled to the client — never top-level
// import it).
import { createFileRoute } from "@tanstack/react-router";
import { managerAgentActions } from "@/lib/validation";
import type { ManagerAgentAction } from "@/lib/validation";
import { AGENT_MANIFEST, AgentError, classifyAction } from "@/lib/manager-agent";
import {
  authenticate,
  dispatch,
  errorResponse,
  json,
  methodNotAllowed,
} from "@/lib/manager-agent-actions";

export const Route = createFileRoute("/api/manager/agent")({
  server: {
    handlers: {
      // Self-description: agents read this to discover the current action set.
      GET: async ({ request }) => {
        try {
          await authenticate(request);
          return json({ ok: true, ...AGENT_MANIFEST });
        } catch (e) {
          return errorResponse(e);
        }
      },
      POST: async ({ request }) => {
        try {
          const actingAs = await authenticate(request);
          const body = (await request.json().catch(() => {
            throw new AgentError(400, "bad_json", "Request body must be valid JSON.");
          })) as { action?: unknown; params?: unknown };

          const classified = classifyAction(body?.action, managerAgentActions);
          if (!classified.ok) {
            throw new AgentError(400, classified.code, classified.message);
          }
          const action = classified.action;

          const result = await dispatch(action as ManagerAgentAction, body?.params ?? {}, actingAs);
          // The version travels on EVERY response, not just the manifest. A
          // client that read the manifest at the start of a long import and
          // cannot re-read it mid-run would otherwise meet "2" as an
          // unexplained 409; now it can compare against its own copy per call
          // and decide to stop and re-read. That is the client `changes` was
          // written for, and until now the one it could not reach.
          return json({ ok: true, version: AGENT_MANIFEST.version, action, result });
        } catch (e) {
          return errorResponse(e);
        }
      },
      PUT: async () => methodNotAllowed(),
      PATCH: async () => methodNotAllowed(),
      DELETE: async () => methodNotAllowed(),
    },
  },
});
