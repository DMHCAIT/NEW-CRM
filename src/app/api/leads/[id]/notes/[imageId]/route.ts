import { fetchLead } from "@/lib/crm-data";
import { dbError, uuid } from "@/lib/live-leads";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { NOTE_IMAGE_TYPES } from "@/lib/note-images";

export async function GET(_request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { supabase } = await requireUser("leads.view");
    const params = await context.params;
    const id = uuid(params.id);
    const lead = await fetchLead(supabase, id);
    if (!lead || lead.isArchived) throw new HttpError(404, "Lead not found.");
    const { data, error } = await supabase.from("note_images")
      .select("mime_type,image_data,note:notes!inner(lead_id)").eq("id", uuid(params.imageId)).eq("note.lead_id", id).maybeSingle();
    dbError(error);
    if (!data) throw new HttpError(404, "Note image not found.");
    if (!NOTE_IMAGE_TYPES.includes(data.mime_type) || typeof data.image_data !== "string" || !/^\\x[0-9a-f]+$/i.test(data.image_data)) {
      throw new HttpError(500, "Stored note image is invalid.");
    }
    return new Response(new Uint8Array(Buffer.from(data.image_data.slice(2), "hex")), { headers: {
      "Content-Type": data.mime_type, "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) { return jsonError(error); }
}
