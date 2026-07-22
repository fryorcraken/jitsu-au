import { encryptConnectionKey, decryptConnectionKey } from "./connection-key-crypto.server";

type ConnectionRow = {
  user_id: string;
  connector_id: string;
  connection_key_ciphertext: string;
  connected_email: string | null;
  metadata: Record<string, unknown>;
};

export async function saveConnectionForUser(params: {
  userId: string;
  connectorId: string;
  connectionAPIKey: string;
  connectedEmail?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const row = {
    user_id: params.userId,
    connector_id: params.connectorId,
    connection_key_ciphertext: encryptConnectionKey(params.connectionAPIKey),
    connected_email: params.connectedEmail ?? null,
    metadata: params.metadata ?? {},
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .upsert(row as never, { onConflict: "user_id,connector_id" });
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
  const row = data as unknown as ConnectionRow;
  return {
    connectionAPIKey: decryptConnectionKey(row.connection_key_ciphertext),
    connectedEmail: row.connected_email,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function updateConnectionMetadata(
  userId: string,
  connectorId: string,
  metadata: Record<string, unknown>,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("app_user_connections")
    .update({ metadata, updated_at: new Date().toISOString() } as never)
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
  return ((data ?? []) as unknown as ConnectionRow[]).map((r) => ({
    userId: r.user_id,
    connectionAPIKey: decryptConnectionKey(r.connection_key_ciphertext),
    connectedEmail: r.connected_email,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}
