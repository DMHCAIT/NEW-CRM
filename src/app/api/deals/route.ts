import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { fetchDealWorkspace } from "@/lib/server/deal-workspace";

export async function GET(request: Request) {
  const started = Date.now();
  try {
    const { supabase, user } = await requireUser("deals.view");
    const authenticated = Date.now();
    const data = await fetchDealWorkspace(supabase, user, new URL(request.url).searchParams);
    return NextResponse.json(data, { headers: {
      "Cache-Control": "private, no-store",
      "Server-Timing": `auth;dur=${authenticated - started}, data;dur=${Date.now() - authenticated}`,
    } });
  } catch (error) { return jsonError(error); }
}
