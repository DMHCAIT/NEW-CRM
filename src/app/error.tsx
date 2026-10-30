"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("CRM page failed", error); }, [error]);
  return <section className="panel" style={{ padding: 24 }}><h1>This page could not be loaded</h1><p>Check the server configuration and database migrations. No demonstration data has been substituted.</p><button className="button button-primary" onClick={reset}>Try again</button></section>;
}
