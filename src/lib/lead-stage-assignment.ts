"use client";

import { apiRequest, clearApiReadCache } from "@/lib/crm-data";

type PendingAssignment = { leadId: string; token: string };
type SaveQueue = { leadId: string; wait: () => Promise<void>; isSaving: () => boolean };
const pending = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let identity: string | null = null;
let saves: SaveQueue | null = null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function persist() {
  if (!identity || typeof window === "undefined") return;
  try { window.sessionStorage.setItem(`crm-stage-assignments:${identity}`, JSON.stringify([...pending])); }
  catch (error) { console.error("Could not retain pending stage assignment retries", error); }
}

export function initializeStageAssignments(userId: string) {
  if (identity === userId) return;
  if (identity) saves = null;
  identity = userId;
  pending.clear();
  if (typeof window === "undefined") return;
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(`crm-stage-assignments:${userId}`) ?? "[]");
    if (!Array.isArray(stored)) throw new Error("Invalid pending stage assignments");
    for (const entry of stored) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(value => typeof value === "string" && uuid.test(value))) {
        throw new Error("Invalid pending stage assignment");
      }
      pending.set(entry[0], entry[1]);
    }
  } catch (error) { console.error("Could not restore pending stage assignment retries", error); }
}

export function rememberStageAssignment(userId: string, leadId: string, token: string | null) {
  if (!identity) initializeStageAssignments(userId);
  if (identity !== userId || (pending.get(leadId) ?? null) === token) return;
  if (token) pending.set(leadId, token);
  else pending.delete(leadId);
  persist();
  listeners.forEach(listener => listener());
}

export function registerLeadSaveQueue(queue: SaveQueue) {
  saves = queue;
  return () => { if (saves === queue) saves = null; };
}

export function subscribeStageAssignments(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function hasLeavingLeadWork(destination: string) {
  return [...pending.keys()].some(id => destination !== `/leads/${id}`)
    || Boolean(saves && destination !== `/leads/${saves.leadId}` && saves.isSaving());
}

async function complete({ leadId, token }: PendingAssignment) {
  const existing = inFlight.get(token);
  if (existing) return existing;
  const operation = (async () => {
    await apiRequest(`/api/leads/${leadId}/assignment`, { method: "POST", body: { token } });
    if (pending.get(leadId) === token) {
      pending.delete(leadId);
      persist();
    }
  })();
  inFlight.set(token, operation);
  try { await operation; }
  finally { if (inFlight.get(token) === operation) inFlight.delete(token); }
}

export async function finishLeavingLeadAssignments(destination: string) {
  const queue = saves;
  if (queue && destination !== `/leads/${queue.leadId}`) await queue.wait();
  await Promise.all([...pending].filter(([id]) => destination !== `/leads/${id}`)
    .map(([leadId, token]) => complete({ leadId, token })));
}

export function finishStageAssignmentsOnUnload() {
  persist();
  for (const [leadId, token] of pending) {
    // Keep retries until the server confirms; browsers may terminate unload requests.
    void fetch(`/api/leads/${leadId}/assignment`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }), keepalive: true,
    }).then(async response => {
      if (!response.ok) throw new Error(`Stage assignment failed (${response.status}): ${await response.text()}`);
      clearApiReadCache();
      if (pending.get(leadId) === token) { pending.delete(leadId); persist(); }
    }).catch(error => console.error("Could not finish stage assignment while leaving the page; it remains pending for retry", error));
  }
}
