"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import {
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useTransition, type MouseEvent, type SyntheticEvent } from "react";
import { navigationItems } from "@/lib/navigation";
import { RolePreviewContext } from "@/components/role-preview-context";
import type { CurrentUser } from "@/lib/types";
import { apiRequest, clearApiReadCache, errorMessage, getApiReadSnapshot, getPendingApiRead, prefetchApiRead, subscribeApiWrites } from "@/lib/crm-data";
import { SectionLoading } from "@/components/section-loading";
import { GlobalLeadSearch } from "@/components/global-lead-search";
import { NotificationBell } from "@/components/notification-bell";
import { loadLeadDetailData } from "@/lib/live-leads-client";
import { prepareSidebarSections, sectionReadPaths } from "@/lib/section-preparation";

export function AppShell({ children, user }: { children: React.ReactNode; user: CurrentUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [destination, setDestination] = useState("");
  const [navigating, startNavigation] = useTransition();
  const preparedDetails = useRef(new Map<string, number>());
  const preparedSections = useRef(new Map<string, number>());
  const sectionPreparation = useRef<ReturnType<typeof prepareSidebarSections> | undefined>(undefined);
  function prefetchSection(href: string, prepareRoute = true, background = false) {
    const preparedAt = preparedSections.current.get(href);
    if (prepareRoute && (!background || href === "/") && href !== "/admin/login-activity"
      && (preparedAt === undefined || Date.now() - preparedAt >= 25000)) {
      router.prefetch(href, { kind: PrefetchKind.FULL });
      preparedSections.current.set(href, Date.now());
    }
    const leadSection = href === "/leads" || href === "/pipeline";
    const detail = /^\/leads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(href);
    if (detail) {
      void loadLeadDetailData(`/api${href}?section=overview`, { maxAgeMs: 30000 }).catch(error => {
        setAccountError(errorMessage(error, "Could not prepare lead details. Open the lead to retry."));
      });
    }
    const dataPaths = user ? sectionReadPaths(href, user) : [];
    return Promise.all(dataPaths.map(dataPath => {
      if (background && getApiReadSnapshot(dataPath) !== undefined) return Promise.resolve();
      const read = leadSection || href === "/notifications"
        ? apiRequest(dataPath, { maxAgeMs: href === "/notifications" ? 15000 : 30000 })
        : prefetchApiRead(dataPath);
      return read.catch((error) => {
        setAccountError(errorMessage(error, "Could not prepare section data. Open the section to retry."));
      });
    }));
  }
  function prepareDetail(event: SyntheticEvent<HTMLDivElement>) {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.search || url.pathname === pathname
      || !/^\/leads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)) return;
    const preparedAt = preparedDetails.current.get(url.pathname);
    if (preparedAt !== undefined && Date.now() - preparedAt < 5000) return;
    if (preparedDetails.current.size >= 30) preparedDetails.current.delete(preparedDetails.current.keys().next().value!);
    preparedDetails.current.set(url.pathname, Date.now());
    router.prefetch(url.pathname, { kind: PrefetchKind.FULL });
    prefetchSection(url.pathname, false);
  }
  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    event.preventDefault();
    sectionPreparation.current?.cancel();
    setMobileOpen(false);
    setAccountError("");
    setDestination(url.pathname);
    // Start data and routing together, including clicks without hover or focus.
    if (!url.search) prefetchSection(url.pathname, false);
    startNavigation(() => router.push(`${url.pathname}${url.search}${url.hash}`));
  }
  const latestPreparation = useRef({ user, pathname, prepare: prefetchSection, router });
  latestPreparation.current = { user, pathname, prepare: prefetchSection, router };
  const permissionKey = user?.permissions.join(",");
  // Clear identity-bound data before child effects start their initial reads.
  useLayoutEffect(() => {
    clearApiReadCache(); preparedSections.current.clear(); preparedDetails.current.clear();
  }, [user?.id, permissionKey]);
  useEffect(() => {
    const unsubscribeStarted = subscribeApiWrites(() => {
      sectionPreparation.current?.cancel();
      preparedSections.current.clear(); preparedDetails.current.clear();
    });
    const unsubscribeCompleted = subscribeApiWrites(() => {
      router.refresh();
    }, "completed");
    return () => { unsubscribeStarted(); unsubscribeCompleted(); };
  }, [router]);
  useEffect(() => {
    // Compiling unused API routes competes with the clicked page in development.
    if (process.env.NODE_ENV === "development") return;
    let task: ReturnType<typeof prepareSidebarSections> | undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const current = latestPreparation.current;
      const actor = current.user;
      if (!actor) return;
      const currentReads = sectionReadPaths(current.pathname, actor).map(path => getPendingApiRead(path));
      void Promise.allSettled(currentReads).then(() => {
        if (cancelled || document.visibilityState !== "visible") return;
        task = prepareSidebarSections(actor, current.pathname, href => latestPreparation.current.prepare(href, true, true), {
          isVisible: () => document.visibilityState === "visible",
          onError: error => setAccountError(errorMessage(error, "Could not prepare section data. Open the section to retry.")),
        });
        sectionPreparation.current = task;
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); task?.cancel(); };
  }, [user?.id, permissionKey, pathname]);
  useEffect(() => {
    if (!user) return;
    const record = () => {
      if (document.visibilityState === "visible") {
        fetch("/api/auth/activity", { method: "POST" }).then(async (response) => {
          if (response.status === 401) { clearApiReadCache(); window.location.assign("/login"); return; }
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.error ?? "Session activity could not be recorded.");
          }
        }).catch((error) => setAccountError(errorMessage(error, "Session activity could not be recorded.")));
      }
    };
    const interval = window.setInterval(record, 60000);
    document.addEventListener("visibilitychange", record);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", record); };
  }, [user]);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);
  if (!user) return <>{children}</>;
  const previewRole = user.profile.role;
  const initials = user.profile.fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  const visibleItems = navigationItems.filter((item) => (!item.permission || user.permissions.includes(item.permission))
    && (item.href !== "/admin/login-activity" || previewRole === "admin" || previewRole === "super_admin"));
  const workspaceItems = visibleItems.filter((item) => item.group === "workspace");
  const manageItems = visibleItems.filter((item) => item.group === "manage");

  return (
    <RolePreviewContext.Provider value={previewRole}>
    <div className="app-layout" onClickCapture={navigate} onMouseOverCapture={prepareDetail} onFocusCapture={prepareDetail} onTouchStartCapture={prepareDetail}>
      <a className="skip-navigation" href="#workspace-content">Skip to content</a>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} aria-label="Workspace sidebar">
        <div className="brand">
          <div>
            <div className="brand-name">IBMP</div>
            <div className="brand-caption">ADMISSIONS CRM</div>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">A</div>
          <div className="workspace-copy">
            <strong>Admissions team</strong>
            <span>Growth workspace</span>
          </div>
        </div>

        <nav id="workspace-navigation" className="side-nav" aria-label="Main navigation">
          {workspaceItems.length > 0 && <div className="nav-label">WORKSPACE</div>}
          {workspaceItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(item.href, navigating ? destination : pathname);
            return (
              <Link
                className={`nav-link ${active ? "nav-link-active" : ""}`}
                href={item.href}
                prefetch={false}
                onMouseEnter={() => prefetchSection(item.href)}
                onFocus={() => prefetchSection(item.href)}
                onTouchStart={() => prefetchSection(item.href)}
                aria-current={active ? "page" : undefined}
                key={item.href}
                onClick={() => setMobileOpen(false)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
              </Link>
            );
          })}

          {manageItems.length > 0 && <div className="nav-label nav-label-spaced">MANAGE</div>}
          {manageItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(item.href, navigating ? destination : pathname);
            return (
              <Link
                className={`nav-link ${active ? "nav-link-active" : ""}`}
                href={item.href}
                prefetch={false}
                onMouseEnter={() => prefetchSection(item.href)}
                onFocus={() => prefetchSection(item.href)}
                onTouchStart={() => prefetchSection(item.href)}
                aria-current={active ? "page" : undefined}
                key={item.href}
                onClick={() => setMobileOpen(false)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="profile-card">
            <div className="avatar avatar-navy">{initials}</div>
            <div className="profile-copy">
              <strong title={user.profile.fullName}>{user.profile.fullName}</strong>
              <span>{previewRole.replace(/_/g, " ")}</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open menu" aria-expanded={mobileOpen} aria-controls="workspace-navigation">
            <Menu size={20} />
          </button>
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{pageName(navigating ? destination : pathname)}</strong></div>
          <div className="topbar-actions">
            {user.permissions.includes("leads.view") && <GlobalLeadSearch />}
            <NotificationBell key={user.id} userId={user.id} />
            <div className="topbar-divider" />
            <button className="topbar-user" aria-label="Sign out" disabled={signingOut} onClick={async () => {
              setSigningOut(true);
              try { await apiRequest("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }
              catch (error) { setAccountError(errorMessage(error, "Sign-out failed.")); setSigningOut(false); }
            }}>
              <span className="avatar avatar-small">{initials}</span>
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main id="workspace-content" className="page-content" tabIndex={-1} aria-busy={navigating}>
          {accountError && <p className="form-error" role="alert">{accountError}</p>}
          {navigating && <SectionLoading title={pageName(destination)} />}
          <div className="section-content" hidden={navigating} inert={navigating}>{children}</div>
        </main>
      </div>
    </div>
    </RolePreviewContext.Provider>
  );
}

function isActiveRoute(href: string, pathname: string) {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname === "/leads" || (pathname.startsWith("/leads/") && pathname !== "/leads/import");
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function pageName(pathname: string) {
  if (pathname === "/") return "Dashboard";
  if (pathname === "/leads/import") return "Import leads";
  if (pathname === "/leads/new") return "New lead";
  if (pathname === "/settings/access/users") return "User access exceptions";
  if (pathname === "/settings/access") return "Role permissions";
  if (pathname.startsWith("/reports/")) return "Report details";
  if (pathname.startsWith("/leads/")) return "Lead details";
  const segment = pathname.split("/").filter(Boolean).pop() ?? "";
  return segment
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
