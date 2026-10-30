import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson } from "@/lib/server/auth";
import { checkOrigin, verifyLogin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const result = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(await readJson(request));
    if (!result.success) throw new HttpError(400, "Enter the six-digit verification code.");
    await verifyLogin(result.data.code);
    return NextResponse.json({ verified: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
