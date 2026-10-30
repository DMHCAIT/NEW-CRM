"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/crm-data";

export function RevokeSession({ sessionId, email, device }: { sessionId: string; email: string; device: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div>
    <button type="button" className="button button-danger button-small" disabled={busy} onClick={async () => {
      if (!confirm(`Sign out ${email} on ${device}? This session must complete email and password verification again to regain CRM access.`)) return;
      setBusy(true); setError("");
      try {
        const result = await apiRequest<{ signInRequired: boolean }>("/api/admin/sessions", { method: "DELETE", body: { sessionId } });
        if (result.signInRequired) { window.location.assign("/login"); return; }
        router.refresh();
      } catch (failure) { setError(errorMessage(failure, "Could not sign out this device.")); }
      finally { setBusy(false); }
    }}>{busy ? "Signing out..." : "Sign out device"}</button>
    {error && <p className="form-error session-action-error" role="alert">{error}</p>}
  </div>;
}
