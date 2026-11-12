import { navigationItems } from "@/lib/navigation";
import type { CurrentUser } from "@/lib/types";

export function sectionReadPaths(href: string, user: CurrentUser) {
  const params = new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (href === "/pipeline") params.set("view", "pipeline");
  if (href === "/leads" || href === "/pipeline") return [`/api/leads?${params}`];
  const paths: Record<string, string[]> = {
    "/notifications": ["/api/notifications"],
    "/meetings": ["/api/meetings"], "/invoices": ["/api/invoices"],
    "/courses": ["/api/courses"], "/automations": ["/api/automations"],
    "/reports": ["/api/reports"], "/users": ["/api/users"], "/settings": ["/api/settings"],
    "/settings/access": ["/api/access"], "/settings/access/users": ["/api/access"],
    "/integrations": ["/api/integrations", "/api/integrations/sources", "/api/integrations/gmail", ...(user.permissions.includes("integrations.manage") ? ["/api/integrations/settings", "/api/integrations/facebook-pages"] : [])],
  };
  return paths[href] ?? [];
}

export function prepareSidebarSections(user: CurrentUser, currentPath: string, prepare: (href: string) => Promise<unknown>,
  options: { isVisible: () => boolean; onError: (error: unknown) => void }) {
  const queue = navigationItems.filter(item => item.href !== currentPath && (!item.permission || user.permissions.includes(item.permission))
    && (item.href === "/" || sectionReadPaths(item.href, user).length > 0)).map(item => item.href);
  return prepareQueue(queue, prepare, options);
}

export function prepareLeadLinks(ids: string[], prepare: (href: string) => Promise<unknown>,
  options: { isVisible: () => boolean; onError: (error: unknown) => void }) {
  const queue = [...new Set(ids)].slice(0, 4).map(id => `/leads/${id}`);
  return prepareQueue(queue, prepare, options);
}

function prepareQueue(queue: string[], prepare: (href: string) => Promise<unknown>,
  options: { isVisible: () => boolean; onError: (error: unknown) => void }) {
  let cancelled = false;
  async function worker() {
    while (!cancelled && options.isVisible()) {
      const href = queue.shift();
      if (!href) return;
      try { await prepare(href); }
      catch (error) { if (!cancelled) options.onError(error); }
    }
  }
  const done = Promise.all([worker(), worker()]);
  return { done, cancel: () => { cancelled = true; } };
}
