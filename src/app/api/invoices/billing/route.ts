import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { accessibleLead, databaseError, parseInput, uuid } from "@/lib/server/operational";

export async function GET(request: Request) {
  try {
    const { supabase, user } = await requireUser("invoices.create");
    const id = parseInput(uuid, new URL(request.url).searchParams.get("leadId"));
    const lead = await accessibleLead(supabase, id);
    const [contact, owner] = await Promise.all([
      supabase.from("leads").select("phone,country_code").eq("id", id).maybeSingle(),
      lead.assignee_id ? supabase.from("profiles").select("full_name,email").eq("id", lead.assignee_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    databaseError(contact.error); databaseError(owner.error);
    const rawPhone = contact.data?.phone ?? "";
    const phone = rawPhone.startsWith("+") ? rawPhone : [contact.data?.country_code, rawPhone].filter(Boolean).join(" ");
    return NextResponse.json({ lead: { ...lead, phone, owner_name: owner.data?.full_name ?? "", owner_email: owner.data?.email ?? "" }, canSaveAddress: user.permissions.includes("leads.edit") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
