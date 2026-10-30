import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson } from "@/lib/server/auth";
import { checkOrigin, startLogin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const result = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(1024) }).safeParse(await readJson(request));
    if (!result.success) throw new HttpError(400, "Enter a valid email and password.");
    await startLogin(request, result.data.email, result.data.password);
    return NextResponse.json({ message: "Verification code sent. Check your email." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
