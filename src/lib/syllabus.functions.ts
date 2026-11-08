// Server functions for the syllabus: the member's "up to belt X" page, and the
// manager's syllabus screen.
//
// Thin on purpose. Every rule lives in `syllabus-admin.ts` (reads, writes,
// republishing belt pages) and `syllabus.ts` (order, assembly, the view), which
// the agent API calls too, so a manager's save and an agent's are the same
// write. These only establish who is asking.
//
// Bundled to the client, so the service-role client is lazy-imported inside
// each handler, never at the top.
import { createServerFn } from "@tanstack/react-start";
import type { KbClient } from "@/lib/kb-types";
import { requireManagerViewer, resolveViewer } from "@/lib/kb.functions";
import {
  deleteBeltSchema,
  deleteSyllabusTopicSchema,
  reorderSyllabusTopicsSchema,
  saveBeltSchema,
  saveSyllabusEntriesSchema,
  saveSyllabusTopicSchema,
} from "@/lib/validation";

async function adminClient(): Promise<KbClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * The syllabus as this reader may see it: every belt whose page they can open,
 * every topic, and those belts' text.
 *
 * All of it in one call rather than filtered by belt and topic here: the whole
 * syllabus is a few dozen short blocks, and having it on the device is what
 * lets a member change the belt or the topic on the mat with no signal. The
 * page picks the belt and topic out of it with `syllabusView`.
 */
export const getSyllabus = createServerFn({ method: "GET" }).handler(async () => {
  const db = await adminClient();
  const [viewer, { loadSyllabus }] = await Promise.all([
    resolveViewer(db),
    import("@/lib/syllabus-admin"),
  ]);
  const data = await loadSyllabus(db, viewer);
  return { ...data, viewer: { signed_in: Boolean(viewer.userId), is_manager: viewer.isManager } };
});

/** Everything, for the manager screen: every belt (with a page or not), topic and block. */
export const getManagerSyllabus = createServerFn({ method: "GET" }).handler(async () => {
  const db = await adminClient();
  await requireManagerViewer(db);
  const { loadSyllabus } = await import("@/lib/syllabus-admin");
  return loadSyllabus(db);
});

/** Save blocks of syllabus text and republish the belt pages they change. */
export const saveManagerSyllabusEntries = createServerFn({ method: "POST" })
  .validator((d: unknown) => saveSyllabusEntriesSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);
    const { saveSyllabusEntries } = await import("@/lib/syllabus-admin");
    return saveSyllabusEntries(db, data, viewer.userId);
  });

/** Create or change a belt. */
export const saveManagerBelt = createServerFn({ method: "POST" })
  .validator((d: unknown) => saveBeltSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);
    const { saveBelt } = await import("@/lib/syllabus-admin");
    return saveBelt(db, data, viewer.userId);
  });

/** Delete a belt that has nothing attached to it. */
export const deleteManagerBelt = createServerFn({ method: "POST" })
  .validator((d: unknown) => deleteBeltSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    await requireManagerViewer(db);
    const { deleteBelt } = await import("@/lib/syllabus-admin");
    return deleteBelt(db, data.slug);
  });

/** Create, rename or move a topic. */
export const saveManagerSyllabusTopic = createServerFn({ method: "POST" })
  .validator((d: unknown) => saveSyllabusTopicSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);
    const { saveSyllabusTopic } = await import("@/lib/syllabus-admin");
    return saveSyllabusTopic(db, data, viewer.userId);
  });

/** Delete a topic nobody has written anything under. */
export const deleteManagerSyllabusTopic = createServerFn({ method: "POST" })
  .validator((d: unknown) => deleteSyllabusTopicSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    await requireManagerViewer(db);
    const { deleteSyllabusTopic } = await import("@/lib/syllabus-admin");
    return deleteSyllabusTopic(db, data.slug);
  });

/** Put several topics in a new order and republish the belt pages once. */
export const reorderManagerSyllabusTopics = createServerFn({ method: "POST" })
  .validator((d: unknown) => reorderSyllabusTopicsSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await adminClient();
    const viewer = await requireManagerViewer(db);
    const { reorderSyllabusTopics } = await import("@/lib/syllabus-admin");
    return reorderSyllabusTopics(db, data, viewer.userId);
  });
