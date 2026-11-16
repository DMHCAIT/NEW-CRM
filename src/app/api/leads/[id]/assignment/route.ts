import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { dbError, uuid } from "@/lib/live-leads";

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ token: z.string().uuid() }).strict();

export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const { supabase } = await requireUser("leads.edit");
    const id = uuid((await context.params).id);
    const input = schema.safeParse(await readJson(request));
    if (!input.success) throw new HttpError(400, "Invalid pending stage assignment token.");
    const { data, error } = await supabase.rpc("finish_lead_stage_assignment", { p_lead_id: id, p_token: input.data.token });
    dbError(error);
    return NextResponse.json({ completed: data });
  } catch (error) { return jsonError(error); }
}
