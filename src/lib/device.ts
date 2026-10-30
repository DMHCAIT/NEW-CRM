export function deviceLabel(userAgent: string | null): string {
  const agent = (userAgent ?? "").slice(0, 1000);
  if (/ipad|macintosh.*mobile/i.test(agent)) return "iPad";
  if (/iphone|ipod/i.test(agent)) return "iPhone";
  if (/android/i.test(agent)) return /mobile/i.test(agent) ? "Android phone" : "Android tablet";
  if (/windows/i.test(agent)) return "Windows computer";
  if (/cros/i.test(agent)) return "Chromebook";
  if (/macintosh|mac os x/i.test(agent)) return "Mac";
  if (/linux/i.test(agent)) return "Linux computer";
  return "Unknown device";
}
