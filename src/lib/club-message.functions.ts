// Server functions behind /manager/messages, and the member's own copy at
// /messages/<id>. Each is a thin gate around `club-message.server.ts`, which
// the manager agent API also calls, so the screen and an agent do the same
// thing to the same data. Product rules: docs/club-messages.md.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireManager } from "@/lib/require-manager";
import {
  clubMessageAudienceSchema,
  sendClubMessageSchema,
  sendClubMessageTestSchema,
} from "@/lib/club-message";

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Every lead a message could go to, newest first, the last 90 days marked. */
export const listMessageLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    return server.listMessageLeads(await adminClient());
  });

/** How many emails a choice of groups and leads would send right now. */
export const countClubMessageAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => clubMessageAudienceSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    return server.countClubMessageAudience(await adminClient(), {
      groups: data.groups,
      leadIds: data.lead_ids,
    });
  });

/** A copy to the manager's own inbox, marked as a test. */
export const sendClubMessageTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => sendClubMessageTestSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    return server.sendClubMessageTest(await adminClient(), {
      managerId: context.userId,
      subject: data.subject,
      body: data.body,
      clickId: data.client_submission_id,
    });
  });

/** Send a message, or finish sending it. Safe to retry with the same `message_id`. */
export const sendClubMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => sendClubMessageSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    try {
      return await server.sendClubMessage(await adminClient(), {
        messageId: data.message_id,
        kind: data.kind,
        subject: data.subject,
        body: data.body,
        groups: data.groups,
        leadIds: data.lead_ids,
        actorId: context.userId,
      });
    } catch (e) {
      // A refusal with a reason reaches the screen as its own words.
      if (e instanceof server.ClubMessageError) throw new Error(e.message);
      throw e;
    }
  });

/** Past messages, newest first, with how far each has got. */
export const listClubMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    return server.listClubMessages(await adminClient());
  });

/** One past message in full, for the manager's history. */
export const getClubMessage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const server = await import("@/lib/club-message.server");
    return server.getClubMessage(await adminClient(), data.id);
  });

/**
 * A message the signed-in person was sent, or null. Not manager-gated: the
 * check is that a copy of it is theirs, which is read with the service role
 * and keyed on the caller's own id, never an id the browser names.
 */
export const getMyClubMessage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const server = await import("@/lib/club-message.server");
    return server.getClubMessageForReader(await adminClient(), {
      messageId: data.id,
      userId: context.userId,
    });
  });
