import type { Json } from "@/integrations/supabase/types";
import { encryptConnectionKey, decryptConnectionKey } from "./connection-key-crypto.server";

// The connector metadata blob is genuinely open-ended (whatever the connector
// hands back), so it crosses the `jsonb` boundary with an explicit cast. Every
// other key is left to the generated row types to check, so a column that goes
// missing from the live schema fails the build rather than failing at runtime.
type ConnectionMetadata = Record<string, unknown>;

export async function saveConnectionForUser(params: {
  userId: string;
  connectorId: string;
  connectionAPIKey: string;
  connectedEmail?: string | null;
  metadata?: ConnectionMetadata;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const row = {
    user_id: params.userId,
    connector_id: params.connectorId,
    connection_key_ciphertext: encryptConnectionKey(params.connectionAPIKey),
    connected_email: params.connectedEmail ?? null,
    metadata: (params.metadata ?? {}) as Json,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .upsert(row, { onConflict: "user_id,connector_id" });
  if (error) throw new Error(error.message);
}

export async function getConnectionForUser(userId: string, connectorId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("app_user_connections")
    .select("user_id, connector_id, connection_key_ciphertext, connected_email, metadata")
    .eq("user_id", userId)
    .eq("connector_id", connectorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    connectionAPIKey: decryptConnectionKey(data.connection_key_ciphertext),
    connectedEmail: data.connected_email,
    metadata: (data.metadata ?? {}) as ConnectionMetadata,
  };
}

export async function updateConnectionMetadata(
  userId: string,
  connectorId: string,
  metadata: ConnectionMetadata,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .update({ metadata: metadata as Json, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("connector_id", connectorId);
  if (error) throw new Error(error.message);
}

export async function deleteConnectionForUser(userId: string, connectorId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .delete()
    .eq("user_id", userId)
    .eq("connector_id", connectorId);
  if (error) throw new Error(error.message);
}

export async function listConnectionsByConnector(connectorId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("app_user_connections")
    .select("user_id, connector_id, connection_key_ciphertext, connected_email, metadata")
    .eq("connector_id", connectorId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    userId: r.user_id,
    connectionAPIKey: decryptConnectionKey(r.connection_key_ciphertext),
    connectedEmail: r.connected_email,
    metadata: (r.metadata ?? {}) as ConnectionMetadata,
  }));
}
