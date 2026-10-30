import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { fetchLeadPage, queryParameters } from "@/lib/server/lead-query";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser("reports.view");
    return NextResponse.json(await fetchLeadPage(supabase, queryParameters(new URL(request.url).searchParams)));
  } catch (error) { return jsonError(error); }
}
