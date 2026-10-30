"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("CRM initialization failed", error); }, [error]);
  return <html lang="en"><body style={{ fontFamily: "Arial, sans-serif", padding: 32 }}>
    <h1>The CRM is temporarily unavailable</h1>
    <p>Check the Supabase environment configuration, database migrations and server logs. No demo account or data has been substituted.</p>
    <button onClick={reset}>Try again</button>
  </body></html>;
}
