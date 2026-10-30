import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { integrationDefinitions } from "@/lib/integration-definitions";
import { integrationStatus } from "@/lib/server/integration-settings";

export async function GET() {
  try {
    await requireUser("integrations.view");
    const integrations = await Promise.all(integrationDefinitions.map(async definition => ({
      ...definition, ...await integrationStatus(definition.id),
    })));
    return NextResponse.json({
      integrations, unsupported: [],
      note: "Save encrypted credentials in CRM, then run a connection check. Provider permissions, user consent and webhook subscriptions must also be completed.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
