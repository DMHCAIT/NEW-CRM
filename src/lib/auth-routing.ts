export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/";
  const pathname = value.split(/[?#]/, 1)[0];
  if (pathname === "/login" || pathname === "/reset-password" || pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return "/";
  return value;
}

export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/reset-password" || pathname.startsWith("/api/auth/")
    || pathname.startsWith("/invoice-status/") || pathname.startsWith("/api/invoice-status/");
}
