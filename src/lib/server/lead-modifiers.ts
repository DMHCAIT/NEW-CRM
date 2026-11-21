import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/live-leads";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type LeadModifier = { modifier_id: string; full_name: string; active: boolean };
type ModifierProfile = { id: string; full_name: string; status: string; deleted_at: string | null };
type ModifierLead = { id: string; modified_by: string | null };

export async function fetchLeadModifiers(client: SupabaseClient, leadIds?: string[]) {
  const modifierIds = new Set<string>();
  let after = "";
  for (;;) {
    let query = client.from("leads").select("id,modified_by").eq("is_archived", false)
      .not("modified_by", "is", null).order("id").limit(1000);
    if (leadIds) query = query.in("id", leadIds);
    if (after) query = query.gt("id", after);
    const { data, error } = await query.returns<ModifierLead[]>();
    dbError(error);
    if (!Array.isArray(data)) throw new Error("Invalid lead modifier response.");
    for (const row of data) if (row.modified_by) modifierIds.add(row.modified_by);
    if (data.length < 1000) break;
    const next = data[data.length - 1].id;
    if (!next || next <= after) throw new Error("Lead modifier pagination did not advance.");
    after = next;
  }

  const modifiers: LeadModifier[] = [];
  const ids = [...modifierIds];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await getSupabaseAdminClient().from("profiles").select("id,full_name,status,deleted_at")
      .in("id", batch).returns<ModifierProfile[]>();
    dbError(error);
    if (!Array.isArray(data) || !data.every(row => typeof row.id === "string" && typeof row.full_name === "string"
      && typeof row.status === "string" && (row.deleted_at === null || typeof row.deleted_at === "string"))) {
      throw new Error("Invalid lead modifier response.");
    }
    if (data.length !== batch.length) throw new Error("Lead editors changed while loading. Refresh and try again.");
    modifiers.push(...data.map(row => ({ modifier_id: row.id, full_name: row.full_name, active: row.status === "active" && row.deleted_at === null })));
  }
  return modifiers;
}
