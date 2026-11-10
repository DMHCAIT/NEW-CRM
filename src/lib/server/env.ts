export class ConfigurationError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`${name} is not configured. Add it to .env.local (and to the Vercel project environment variables).`);
  return value;
}

export function appUrl(purpose?: "invoice" | "notification"): string {
  const publicUrlKey = purpose === "notification" ? "NOTIFICATION_PUBLIC_URL" : "INVOICE_PUBLIC_URL";
  const publicUrl = purpose ? process.env[publicUrlKey] : undefined;
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("Invalid public origin");
      return url.origin;
    } catch {
      throw new ConfigurationError(`${publicUrlKey} must be a public HTTPS origin without a path, query or credentials.`);
    }
  }
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
