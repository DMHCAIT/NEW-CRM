import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError, parseInput } from "@/lib/server/operational";

const ruleKeys = ["facebook", "website", "junk", "not_interested", "closed_won"] as const;
const assignmentSchema = z.object({
  rule_key: z.enum(ruleKeys),
  enabled: z.boolean(),
  strategy: z.enum(["single", "round_robin"]),
  owner_ids: z.array(z.string().uuid()).max(100),
}).strict().superRefine((rule, context) => {
  if (new Set(rule.owner_ids).size !== rule.owner_ids.length)
    context.addIssue({ code: "custom", message: "Each user can only be selected once.", path: ["owner_ids"] });
  if (rule.rule_key !== "facebook" && rule.rule_key !== "website" && rule.strategy !== "single")
    context.addIssue({ code: "custom", message: "Stage assignment rules use one selected user.", path: ["strategy"] });
  if (rule.enabled && rule.owner_ids.length === 0)
    context.addIssue({ code: "custom", message: "Select at least one active user before enabling this rule.", path: ["owner_ids"] });
  if (rule.strategy === "single" && rule.owner_ids.length > 1)
    context.addIssue({ code: "custom", message: "Select exactly one user for a single-owner rule.", path: ["owner_ids"] });
});

export async function GET() {
  try {
    const { supabase, user } = await requireUser("automations.view");
    const canManage = user.permissions.includes("automations.manage");
    if (!canManage) return NextResponse.json({ canManage, users: [], rules: [] }, { headers: { "Cache-Control": "no-store" } });
    const admin = getSupabaseAdminClient();
    const [{ data: activeUsers, error: usersError }, { data: rules, error: rulesError }] = await Promise.all([
      supabase.from("profiles").select("id,full_name").eq("status", "active").is("deleted_at", null).order("full_name"),
      admin.from("lead_assignment_automations").select("rule_key,enabled,strategy,owner_ids,next_owner_index").order("rule_key"),
    ]);
    databaseError(usersError);
    databaseError(rulesError);
    const activeIds = new Set((activeUsers ?? []).map(profile => profile.id));
    const inactiveIds = [...new Set((rules ?? []).flatMap(rule => rule.owner_ids as string[]).filter(id => !activeIds.has(id)))];
    const { data: inactiveUsers, error: inactiveError } = inactiveIds.length
      ? await admin.from("profiles").select("id,full_name").in("id", inactiveIds).order("full_name")
      : { data: [], error: null };
    databaseError(inactiveError);
    const users = [
      ...(activeUsers ?? []).map(profile => ({ ...profile, active: true })),
      ...(inactiveUsers ?? []).map(profile => ({ ...profile, active: false })),
    ];
    return NextResponse.json({ canManage, users, rules: rules ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const { supabase } = await requireUser("automations.manage");
    const input = parseInput(assignmentSchema, await readJson(request));
    if (input.enabled && input.owner_ids.length) {
      const { data: users, error } = await supabase.from("profiles").select("id")
        .in("id", input.owner_ids).eq("status", "active").is("deleted_at", null);
      databaseError(error);
      if (users?.length !== input.owner_ids.length) throw new HttpError(400, "Choose only active CRM users.");
    }
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("lead_assignment_automations").upsert({
      rule_key: input.rule_key,
      enabled: input.enabled,
      strategy: input.strategy,
      owner_ids: input.owner_ids,
      next_owner_index: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "rule_key" }).select("rule_key,enabled,strategy,owner_ids,next_owner_index").single();
    databaseError(error);
    return NextResponse.json({ rule: data });
  } catch (error) { return jsonError(error); }
}
