import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "Email password-reset links are no longer supported. Contact your Super Admin to change your password." }, { status: 410 });
}
