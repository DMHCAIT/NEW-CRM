export function countryCallingPrefix(countryCode: string): string {
  const value = countryCode.trim();
  return value.match(/\(\+(\d{1,3})\)/)?.[1] ?? value.match(/^\+?(\d{1,3})$/)?.[1] ?? "";
}

export function countryCodeMatchesOptions(value: string, options: string[]): boolean {
  const prefix = countryCallingPrefix(value);
  return Boolean(prefix && options.some(option => countryCallingPrefix(option) === prefix));
}

export function phoneIncludesCountryCallingCode(phone: string, countryCode = ""): boolean {
  if (phone.trim().startsWith("+") || countryCallingPrefix(countryCode)) return true;
  return countryCode.trim() === "" && /^91\d{10}$/.test(phone.replace(/\D/g, ""));
}

export function normalizePhone(phone: string, countryCode = ""): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return digits;
  const prefix = countryCallingPrefix(countryCode);
  // A local ten-digit number can itself begin with its calling code (e.g. 91).
  const includesPrefix = Boolean(prefix) && digits.length > 10 && digits.startsWith(prefix);
  return prefix && !includesPrefix ? `${prefix}${digits}` : digits;
}

export function leadCallNumber(phone: string, countryCode?: string): string | null {
  const trimmed = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  const number = normalizePhone(phone, countryCode);
  return number.length <= 15 ? `${phoneIncludesCountryCallingCode(phone, countryCode) ? "+" : ""}${number}` : null;
}
