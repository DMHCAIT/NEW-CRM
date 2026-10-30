import type { SupabaseClient } from "@supabase/supabase-js";
import { isCrmRole } from "@/lib/permissions";
import type { Lead, Profile } from "@/lib/types";

export const LEAD_SELECT = [
  "id,name,phone,country_code,alt_phone,email,country,course,qualification,category,stage_id,source,assignee_id,created_by,modified_by",
  "closure_fee,next_followup_at,last_visit_at,merged_into_id,is_archived,created_at,modified_at,has_been_edited,edited_at",
  "stage:lead_stages(name)",
  "assignee:profiles!leads_assignee_id_fkey(full_name)",
  "modifier:profiles!leads_modified_by_fkey(full_name)",
].join(",");
const LEGACY_LEAD_SELECT = [
  "id,name,phone,alt_phone,email,country,course,qualification,stage_id,source,assignee_id,created_by,modified_by",
  "closure_fee,next_followup_at,last_visit_at,merged_into_id,is_archived,created_at,modified_at,has_been_edited,edited_at",
  "stage:lead_stages(name)",
  "assignee:profiles!leads_assignee_id_fkey(full_name)",
  "modifier:profiles!leads_modified_by_fkey(full_name)",
].join(",");

type NameRef = { name?: string; full_name?: string } | { name?: string; full_name?: string }[] | null;

export type LeadRow = {
  id: string;
  name: string;
  phone: string;
  country_code?: string | null;
  alt_phone: string | null;
  email: string | null;
  country: string | null;
  course: string | null;
  qualification: string | null;
  category?: string | null;
  stage_id: string | null;
  source: string;
  assignee_id: string | null;
  created_by: string;
  modified_by: string | null;
  closure_fee: number | string;
  next_followup_at: string | null;
  last_visit_at: string | null;
  merged_into_id: string | null;
  is_archived: boolean;
  created_at: string;
  modified_at: string;
  has_been_edited: boolean | null;
  edited_at: string[] | null;
  stage?: NameRef;
  assignee?: NameRef;
  modifier?: NameRef;
};

export type ProfileRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  reporting_to: string | null;
  status: string;
  ivr_extension: string | null;
  deleted_at: string | null;
};

export const PROFILE_SELECT = "id,full_name,email,phone,role,reporting_to,status,ivr_extension,deleted_at";

export type StageRow = { id: string; name: string; sort_order: number; is_active: boolean; is_terminal: boolean; color: string | null };

function refName(ref: NameRef | undefined): string {
  const value = Array.isArray(ref) ? ref[0] : ref;
  return value?.name ?? value?.full_name ?? "";
}

function missingLeadAdmissionColumns(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLocaleLowerCase();
  return error.code === "42703" && (text.includes("country_code") || text.includes("category"));
}

let dateTimeFormatter: Intl.DateTimeFormat | undefined;

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  dateTimeFormatter ??= new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });
  return dateTimeFormatter.format(date);
}

export function mapLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    countryCode: row.country_code ?? undefined,
    altPhone: row.alt_phone ?? undefined,
    email: row.email ?? "",
    country: row.country ?? "",
    course: row.course ?? "",
    qualification: row.qualification ?? "",
    category: row.category ?? "",
    stage: refName(row.stage),
    stageId: row.stage_id ?? undefined,
    source: row.source,
    assignee: refName(row.assignee),
    assigneeId: row.assignee_id ?? undefined,
    followUp: formatDateTime(row.next_followup_at) || "—",
    followUpAt: row.next_followup_at ?? undefined,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    modifiedBy: refName(row.modifier),
    lastVisitAt: row.last_visit_at ?? undefined,
    hasBeenEdited: row.has_been_edited ?? undefined,
    editedAt: row.edited_at ?? undefined,
    mergedIntoId: row.merged_into_id ?? undefined,
    isArchived: row.is_archived,
    closureFee: Number(row.closure_fee),
  };
}

export function mapProfile(row: ProfileRow, email = ""): Profile {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email ?? email,
    phone: row.phone ?? "",
    role: isCrmRole(row.role) ? row.role : "counselor",
    reportingTo: row.reporting_to,
    status: row.status === "inactive" ? "inactive" : "active",
    ivrExtension: row.ivr_extension ?? "",
    deletedAt: row.deleted_at,
  };
}

const PAGE_SIZE = 1000;

export async function fetchLead(client: SupabaseClient, id: string): Promise<Lead | null> {
  const primary = await client.from("leads").select(LEAD_SELECT).eq("id", id).maybeSingle<LeadRow>();
  if (!primary.error) return primary.data ? mapLead(primary.data) : null;
  if (!missingLeadAdmissionColumns(primary.error)) throw new Error(primary.error.message);
  const fallback = await client.from("leads").select(LEGACY_LEAD_SELECT).eq("id", id).maybeSingle<LeadRow>();
  if (fallback.error) throw new Error(fallback.error.message);
  return fallback.data ? mapLead(fallback.data) : null;
}

export async function fetchStages(client: SupabaseClient, options: { includeInactive?: boolean } = {}): Promise<StageRow[]> {
  let query = client.from("lead_stages").select("id,name,sort_order,is_active,is_terminal,color").order("sort_order");
  if (!options.includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query.returns<StageRow[]>();
  if (error) throw new Error(error.message);
  return data;
}

/** Profiles visible to the user (own hierarchy, or everyone for users.view holders). */
export async function fetchProfiles(client: SupabaseClient, options: { includeInactive?: boolean } = {}): Promise<Profile[]> {
  const profiles: Profile[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client.from("profiles").select(PROFILE_SELECT).is("deleted_at", null).order("full_name").order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (!options.includeInactive) query = query.eq("status", "active");
    const { data, error } = await query.returns<ProfileRow[]>();
    if (error) throw new Error(error.message);
    profiles.push(...data.map((row) => mapProfile(row)));
    if (data.length < PAGE_SIZE) return profiles;
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

/** Calls a CRM API route and throws with the server's error message on failure. */
const browserReads = new Map<string, { value: unknown; savedAt: number }>();
const pendingBrowserReads = new Map<string, Promise<unknown>>();
let readGeneration = 0;

export function clearApiReadCache() {
  readGeneration++;
  browserReads.clear();
  pendingBrowserReads.clear();
}

export function getCachedApiRead<T>(path: string, maxAgeMs = 30000): T | undefined {
  if (typeof window === "undefined" || !path.startsWith("/api/") || path.startsWith("/api/auth/")) return undefined;
  const saved = browserReads.get(path);
  const ageLimit = Math.min(Math.max(maxAgeMs, 0), 30000);
  if (saved && Date.now() - saved.savedAt < ageLimit) return saved.value as T;
  return undefined;
}

export async function apiRequest<T = unknown>(path: string, init: { method?: string; body?: unknown; maxAgeMs?: number } = {}): Promise<T> {
  const method = (init.method ?? (init.body === undefined ? "GET" : "POST")).toUpperCase();
  const browserRead = typeof window !== "undefined" && method === "GET" && path.startsWith("/api/") && !path.startsWith("/api/auth/");
  const maxAgeMs = Math.min(Math.max(init.maxAgeMs ?? 0, 0), 30000);
  if (browserRead) {
    const saved = getCachedApiRead<T>(path, maxAgeMs);
    if (saved !== undefined) return saved;
    browserReads.delete(path);
    const pending = pendingBrowserReads.get(path);
    if (pending) return pending as Promise<T>;
  }
  if (method !== "GET") clearApiReadCache();
  const generation = readGeneration;
  const request = async (): Promise<T> => {
    try {
      const payload = await fetchApi<T>(path, method, init.body);
      if (browserRead && maxAgeMs > 0 && generation === readGeneration) {
        if (browserReads.size >= 30) browserReads.delete(browserReads.keys().next().value!);
        browserReads.set(path, { value: payload, savedAt: Date.now() });
      }
      return payload;
    } finally {
      if (method !== "GET") clearApiReadCache();
    }
  };
  const pending = request();
  if (browserRead) pendingBrowserReads.set(path, pending);
  try { return await pending; }
  finally {
    if (pendingBrowserReads.get(path) === pending) pendingBrowserReads.delete(path);
  }
}

async function fetchApi<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearApiReadCache();
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}
