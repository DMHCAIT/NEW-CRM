import { NextResponse } from "next/server";
import { cache } from "react";
import { headers } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { decodePageUser, loadCurrentUser, PAGE_USER_HEADER } from "@/lib/current-user";
import { ConfigurationError } from "@/lib/server/env";
import type { CurrentUser, Permission } from "@/lib/types";

export { loadCurrentUser } from "@/lib/current-user";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const requestUser = cache(async () => {
  const supabase = await getSupabaseServerClient();
  return { supabase, user: await loadCurrentUser(supabase) };
});

/** For Server Components: returns null when Supabase is not configured or nobody is signed in. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const pageUser = (await headers()).get(PAGE_USER_HEADER);
    if (pageUser !== null) return decodePageUser(pageUser);
    return (await requestUser()).user;
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

/** For API routes: resolves the signed-in, active CRM user and optionally checks a permission. */
export async function requireUser(permission?: Permission) {
  const { supabase, user } = await requestUser();
  if (!user) throw new HttpError(401, "Sign in with an active CRM account.");
  if (permission && !user.permissions.includes(permission)) throw new HttpError(403, "You do not have permission for this action.");
  return { supabase, user };
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
  console.error(error);
  return NextResponse.json({ error: "The operation failed. Contact your administrator if the problem persists." }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function requireString(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required.`);
  if (value.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return value.trim();
}

export function optionalString(value: unknown, maxLength = 2000): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "Invalid text value.");
  if (value.length > maxLength) throw new HttpError(400, "Text value is too long.");
  return value.trim() || null;
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
