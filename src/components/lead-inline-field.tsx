"use client";

import { useEffect, useRef, useState } from "react";
import { SearchableDropdown } from "@/components/searchable-dropdown";

export function LeadInlineField({ label, value, onSave, options, type = "text", readOnly = false, required = false, maxLength = 200 }: {
  label: string; value: string; onSave: (value: string) => Promise<void>;
  options?: { value: string; label: string }[];
  type?: "text" | "email" | "tel" | "number" | "datetime-local";
  readOnly?: boolean; required?: boolean; maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  async function save(next: string) {
    if (saving.current || next === value) return;
    saving.current = true; setStatus("Saving..."); setError("");
    try { await onSave(next); setStatus("Saved"); }
    catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : "Could not save this field."); }
    finally { saving.current = false; }
  }
  return <div className={`lead-inline-field${error ? " has-error" : ""}`}>
    <label>
      <span className="lead-inline-label">{label}</span>
      {readOnly ? <span className="lead-inline-readonly">{options?.find(option => option.value === value)?.label || value || "Not provided"}</span> : options
        ? <SearchableDropdown ariaLabel={label} placeholder="Not provided" value={draft} options={options} disabled={status === "Saving..."} onChange={next => { setDraft(next); void save(next); }} />
        : <input aria-label={label} aria-invalid={Boolean(error)} type={type} value={draft} required={required} maxLength={maxLength}
          min={type === "number" ? 0 : undefined} step={type === "number" ? "0.01" : undefined}
          disabled={status === "Saving..."} placeholder="Not provided"
          onChange={event => { setDraft(event.target.value); setStatus(event.target.value === value ? "" : "Unsaved"); setError(""); }}
          onBlur={event => {
            if (event.currentTarget.reportValidity()) void save(draft);
            else { setError(event.currentTarget.validationMessage); setStatus(""); }
          }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") { setDraft(value); setError(""); setStatus(""); }
          }} />}
    </label>
    {!readOnly && <span className="lead-field-status" role="status">{status}</span>}
    {error && <div className="lead-field-error" role="alert">{error} <button type="button" onClick={() => void save(draft)}>Retry</button></div>}
  </div>;
}
