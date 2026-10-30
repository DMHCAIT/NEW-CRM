import nodemailer from "nodemailer";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ConfigurationError } from "@/lib/server/env";
import { requireIntegrationValue } from "@/lib/server/integration-settings";

export function publicSmtpAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a > 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith("2001:db8:");
}
export async function smtpTransport(config: Record<string, string>) {
  const hostname = requireIntegrationValue(config, "SMTP_HOST");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(value => !publicSmtpAddress(value.address))) throw new ConfigurationError("SMTP server must resolve only to public internet addresses.");
  const address = addresses.find(value => value.family === 4) ?? addresses[0];
  const port = Number(config.SMTP_PORT || "587");
  if (![465, 587, 2525].includes(port)) throw new ConfigurationError("SMTP port must be 465, 587 or 2525.");
  const secure = config.SMTP_SECURE ? config.SMTP_SECURE === "true" : port === 465;
  if (config.SMTP_SECURE && !["true", "false"].includes(config.SMTP_SECURE)) throw new ConfigurationError("SMTP_SECURE must be true or false.");
  if (port === 465 && !secure) throw new ConfigurationError("SMTP port 465 requires TLS.");
  return nodemailer.createTransport({
    host: address.address, port, secure, requireTLS: !secure,
    tls: { servername: hostname, rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: { user: requireIntegrationValue(config, "SMTP_USER"), pass: requireIntegrationValue(config, "SMTP_PASSWORD") },
  });
}
