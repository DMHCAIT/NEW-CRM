import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { jsonError } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.rpc("end_login_session");
    if (error) throw error;
    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    if (signOutError) throw signOutError;
    return NextResponse.json({ signedOut: true });
  } catch (error) { return jsonError(error); }
}
