export class ConfigurationError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`${name} is not configured. Add it to .env.local (and to the Vercel project environment variables).`);
  return value;
}

export function appUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
