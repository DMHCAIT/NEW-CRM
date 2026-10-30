import { NextResponse } from "next/server";
import { requireUser, jsonError } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc("touch_login_session");
    if (error) throw error;
    return NextResponse.json({ recorded: true });
  } catch (error) { return jsonError(error); }
}
