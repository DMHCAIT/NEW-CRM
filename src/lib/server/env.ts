export class ConfigurationError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`${name} is not configured. Add it to .env.local (and to the Vercel project environment variables).`);
  return value;
}

export function appUrl(purpose?: "invoice"): string {
  if (purpose === "invoice" && process.env.INVOICE_PUBLIC_URL) {
    try {
      const url = new URL(process.env.INVOICE_PUBLIC_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("Invalid invoice origin");
      return url.origin;
    } catch {
      throw new ConfigurationError("INVOICE_PUBLIC_URL must be a public HTTPS origin without a path, query or credentials.");
    }
  }
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
