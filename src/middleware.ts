import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "@/lib/auth-routing";
import { encodePageUser, loadCurrentUser, PAGE_USER_HEADER } from "@/lib/current-user";
import type { CurrentUser, Permission } from "@/lib/types";

const permissionRoutes: [string, Permission][] = [
  ["/settings/access", "access.manage"], ["/settings", "settings.manage"], ["/users", "users.view"],
  ["/leads/import", "leads.import"], ["/leads", "leads.view"], ["/pipeline", "pipeline.view"],
  ["/meetings", "meetings.view"], ["/invoices", "invoices.view"], ["/reports", "reports.view"],
  ["/automations", "automations.view"], ["/integrations", "integrations.view"], ["/", "dashboard.view"],
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  // Never accept browser-supplied identity, including on routes with their own auth.
  requestHeaders.delete(PAGE_USER_HEADER);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
  // Route handlers validate and refresh their own sessions through requireUser.
  if (pathname.startsWith("/api/")) return next();
  // Webhooks validate provider signatures inside their handlers, not browser sessions.
  const isPublic = isPublicPath(pathname) || pathname.startsWith("/api/webhooks/");
  // These handlers validate their own credentials; login alone needs a signed-in redirect.
  if (isPublic && pathname !== "/login") return next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (isPublic) return next();
    const target = request.nextUrl.clone();
    target.pathname = "/login";
    return NextResponse.redirect(target);
  }

  let response = next();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        requestHeaders.set("cookie", request.headers.get("cookie") ?? "");
        response = next();
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const permission = !isPublic
    ? permissionRoutes.find(([path]) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)))?.[1]
    : undefined;
  let user: CurrentUser | null = null;
  try {
    user = await loadCurrentUser(supabase, true);
  } catch (error) {
    console.error("Unable to validate CRM session", error);
    return NextResponse.json({ error: "Session validation is unavailable. Contact your administrator." }, { status: 503 });
  }

  if (!user && !isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = "/login";
    target.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    const redirect = NextResponse.redirect(target);
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }
  if (user && pathname === "/login") {
    const target = request.nextUrl.clone();
    target.pathname = "/";
    target.search = "";
    const redirect = NextResponse.redirect(target);
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }
  if (user && permission && !user.permissions.includes(permission)) {
    return new NextResponse("You do not have permission to view this page.", { status: 403 });
  }
  requestHeaders.set(PAGE_USER_HEADER, encodePageUser(user));
  const forwarded = next();
  response.cookies.getAll().forEach(cookie => forwarded.cookies.set(cookie));
  return forwarded;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
