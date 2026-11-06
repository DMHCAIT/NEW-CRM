import { NextResponse } from "next/server";
import { z } from "zod";
import { companyInput, courseInput } from "@/lib/billing";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput } from "@/lib/server/operational";
import { checkOrigin } from "@/lib/server/login";

export async function GET() {
  try {
    const { supabase, user } = await requireUser("invoices.view");
    const [courses, companies] = await Promise.all([
      supabase.from("courses").select("*").order("name").limit(1000),
      supabase.from("invoice_companies").select("*").order("code"),
    ]);
    databaseError(courses.error); databaseError(companies.error);
    return NextResponse.json({ courses: courses.data, companies: companies.data,
      canManage: ["admin", "super_admin"].includes(user.profile.role) && user.permissions.includes("settings.manage") });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("settings.manage");
    if (!["admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Only administrators can manage course prices and billing companies.");
    const input = parseInput(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("course"), id: z.string().uuid().optional(), values: courseInput }),
      z.object({ kind: z.literal("company"), values: companyInput }),
    ]), await readJson(request));
    if (input.kind === "company") {
      const { data, error } = await supabase.from("invoice_companies").update(input.values).eq("code", input.values.code).select("code").maybeSingle();
      databaseError(error);
      if (!data) throw new HttpError(404, "Billing company not found.");
    } else {
      const values = { ...input.values, updated_at: new Date().toISOString() };
      const result = input.id
        ? await supabase.from("courses").update(values).eq("id", input.id).select("id").maybeSingle()
        : await supabase.from("courses").insert(values).select("id").single();
      if (result.error?.code === "23505") throw new HttpError(409, "A course with that name already exists.");
      databaseError(result.error);
      if (!result.data) throw new HttpError(404, "Course not found.");
    }
    return NextResponse.json({ message: input.kind === "course" ? "Course saved. Existing invoice prices remain unchanged." : "Company saved. Existing invoice templates remain unchanged." });
  } catch (error) { return jsonError(error); }
}
