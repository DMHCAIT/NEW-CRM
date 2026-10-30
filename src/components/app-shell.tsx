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
import { useEffect, useState } from "react";
import { navigationItems } from "@/lib/navigation";
import { RolePreviewContext } from "@/components/role-preview-context";
import type { CurrentUser } from "@/lib/types";
import { apiRequest, clearApiReadCache, errorMessage } from "@/lib/crm-data";

export function AppShell({ children, user }: { children: React.ReactNode; user: CurrentUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  function prefetchSection(href: string) {
    router.prefetch(href);
    const params = new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (href === "/pipeline") params.set("view", "pipeline");
    const leadSection = href === "/leads" || href === "/pipeline";
    const dataPath = leadSection ? `/api/leads?${params}` : href === "/meetings" || href === "/invoices" ? `/api${href}` : null;
    if (dataPath) {
      void apiRequest(dataPath, { maxAgeMs: leadSection ? 30000 : 0 }).catch((error) => {
        setAccountError(errorMessage(error, "Could not prepare section data. Open the section to retry."));
      });
    }
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
    <div className="app-layout">
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
            const active = isActiveRoute(item.href, pathname);
            return (
              <Link
                className={`nav-link ${active ? "nav-link-active" : ""}`}
                href={item.href}
                prefetch={true}
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
            const active = isActiveRoute(item.href, pathname);
            return (
              <Link
                className={`nav-link ${active ? "nav-link-active" : ""}`}
                href={item.href}
                prefetch={true}
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
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{pageName(pathname)}</strong></div>
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
        <main className="page-content">{accountError && <p className="form-error" role="alert">{accountError}</p>}{children}</main>
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
