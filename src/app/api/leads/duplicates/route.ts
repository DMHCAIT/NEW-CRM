import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { dbError, normalizePhone } from "@/lib/live-leads";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser("leads.create");
    const params = new URL(request.url).searchParams;
    const phone = (params.get("phone") ?? "").slice(0, 30);
    const email = (params.get("email") ?? "").trim().slice(0, 254);
    const countryCode = (params.get("countryCode") ?? "").slice(0, 160);
    const checkPhone = phone.replace(/\D/g, "").length >= 7 ? normalizePhone(phone, countryCode) : "";
    const checkEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
    if (!checkPhone && !checkEmail) return NextResponse.json({ matches: [] });
    const { data, error } = await supabase.rpc("find_live_lead_duplicates", { check_phone: checkPhone, check_email: checkEmail });
    dbError(error);
    return NextResponse.json({ matches: data ?? [] });
  } catch (error) { return jsonError(error); }
}
