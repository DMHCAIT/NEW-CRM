export function normalizePhone(phone: string, countryCode = ""): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return digits;
  const prefix = countryCode.match(/\(\+(\d+)/)?.[1] ?? "";
  // A local ten-digit number can itself begin with its calling code (e.g. 91).
  const includesPrefix = digits.length > 10 && digits.startsWith(prefix);
  return prefix && !includesPrefix ? `${prefix}${digits}` : digits;
}

export function leadCallNumber(phone: string, countryCode?: string): string | null {
  const trimmed = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  const prefix = countryCode?.match(/\(\+(\d+)/)?.[1];
  const number = normalizePhone(phone, countryCode);
  return number.length <= 15 ? `${prefix ? "+" : ""}${number}` : null;
}
