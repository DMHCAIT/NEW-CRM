export function leadCallNumber(phone: string, countryCode?: string): string | null {
  const trimmed = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  const prefix = countryCode?.match(/\(\+(\d+)/)?.[1];
  const number = prefix ? digits.startsWith(prefix) ? digits : `${prefix}${digits}` : digits;
  return number.length <= 15 ? `${prefix ? "+" : ""}${number}` : null;
}
