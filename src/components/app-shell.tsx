"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  LogOut,
  Menu,
  Search,
  X,
} from "lucide-react";
import { useEffect, useState, useTransition, type MouseEvent } from "react";
import { navigationItems } from "@/lib/navigation";
import { RolePreviewContext } from "@/components/role-preview-context";
import type { CurrentUser } from "@/lib/types";
import { apiRequest, clearApiReadCache, errorMessage, prefetchApiRead } from "@/lib/crm-data";
import { SectionLoading } from "@/components/section-loading";

export function AppShell({ children, user }: { children: React.ReactNode; user: CurrentUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [destination, setDestination] = useState("");
  const [navigating, startNavigation] = useTransition();
  const [intentHref, setIntentHref] = useState("");
  function prefetchSection(href: string, prepareRoute = true) {
    if (prepareRoute) setIntentHref(href);
    const params = new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (href === "/pipeline") params.set("view", "pipeline");
    const leadSection = href === "/leads" || href === "/pipeline";
    const operationalPaths: Record<string, string[]> = {
      "/meetings": ["/api/meetings"], "/invoices": ["/api/invoices"],
      "/courses": ["/api/courses"], "/automations": ["/api/automations"],
      "/reports": ["/api/reports"], "/users": ["/api/users"], "/settings": ["/api/settings"],
      "/integrations": ["/api/integrations", "/api/integrations/sources", "/api/integrations/gmail"],
    };
    const dataPaths = leadSection ? [`/api/leads?${params}`] : operationalPaths[href] ?? [];
    for (const dataPath of dataPaths) {
      const read = leadSection ? apiRequest(dataPath, { maxAgeMs: 30000 }) : prefetchApiRead(dataPath);
      void read.catch((error) => {
        setAccountError(errorMessage(error, "Could not prepare section data. Open the section to retry."));
      });
    }
  }
  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    event.preventDefault();
    setMobileOpen(false);
    setAccountError("");
    setDestination(url.pathname);
    // Start data and routing together, including clicks without hover or focus.
    if (!url.search) prefetchSection(url.pathname, false);
    startNavigation(() => router.push(`${url.pathname}${url.search}${url.hash}`));
  }
  useEffect(() => { clearApiReadCache(); }, [user?.id]);
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
  const visibleItems = navigationItems.filter((item) => user.permissions.includes(item.permission)
    && (item.href !== "/admin/login-activity" || previewRole === "admin" || previewRole === "super_admin"));
  const workspaceItems = visibleItems.filter((item) => item.group === "workspace");
  const manageItems = visibleItems.filter((item) => item.group === "manage");

  return (
    <RolePreviewContext.Provider value={previewRole}>
    <div className="app-layout" onClickCapture={navigate}>
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
          <div className="brand-mark" aria-hidden="true">D</div>
          <div>
            <div className="brand-name">DMHCA</div>
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
                prefetch={intentHref === item.href && item.href !== "/"}
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
                prefetch={intentHref === item.href && item.href !== "/admin/login-activity"}
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
            <Link className="search-trigger" href="/leads" aria-label="Search leads">
              <Search size={16} />
              <span>Search leads</span>
            </Link>
            <Link className="icon-button topbar-icon" href="/notifications" aria-label="Notifications">
              <Bell size={19} />
            </Link>
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
