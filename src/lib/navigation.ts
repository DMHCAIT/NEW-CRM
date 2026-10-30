import {
  Activity,
  BarChart3,
  Blocks,
  CalendarDays,
  ChartNoAxesCombined,
  FileText,
  FileUp,
  LayoutDashboard,
  ListChecks,
  Settings2,
  ShieldCheck,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/types";

export interface NavigationItem {
  label: string;
  href: string;
  icon: LucideIcon;
  permission: Permission;
  group: "workspace" | "manage";
}

export const navigationItems: NavigationItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard, permission: "dashboard.view", group: "workspace" },
  { label: "Leads", href: "/leads", icon: UsersRound, permission: "leads.view", group: "workspace" },
  { label: "Pipeline", href: "/pipeline", icon: Blocks, permission: "pipeline.view", group: "workspace" },
  { label: "Meetings", href: "/meetings", icon: CalendarDays, permission: "meetings.view", group: "workspace" },
  { label: "Invoices", href: "/invoices", icon: FileText, permission: "invoices.view", group: "workspace" },
  { label: "Reports", href: "/reports", icon: ChartNoAxesCombined, permission: "reports.view", group: "workspace" },
  { label: "Automations", href: "/automations", icon: ListChecks, permission: "automations.view", group: "manage" },
  { label: "Import", href: "/leads/import", icon: FileUp, permission: "leads.import", group: "manage" },
  { label: "Integrations", href: "/integrations", icon: Activity, permission: "integrations.view", group: "manage" },
  { label: "Users", href: "/users", icon: Users, permission: "users.view", group: "manage" },
  { label: "Login activity", href: "/admin/login-activity", icon: ShieldCheck, permission: "access.manage", group: "manage" },
  { label: "Access control", href: "/settings/access", icon: ShieldCheck, permission: "access.manage", group: "manage" },
  { label: "CRM settings", href: "/settings", icon: Settings2, permission: "settings.manage", group: "manage" },
];

export const dashboardIcon = BarChart3;
