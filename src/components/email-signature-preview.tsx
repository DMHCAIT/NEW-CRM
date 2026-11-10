"use client";

export function EmailSignaturePreview({ html }: { html: string }) {
  return <iframe title="Email signature preview" className="email-signature-preview" sandbox="" referrerPolicy="no-referrer"
    srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:8px;font:14px Arial,sans-serif;color:#263238}a{color:#1a73e8}</style></head><body>${html}</body></html>`} />;
}
