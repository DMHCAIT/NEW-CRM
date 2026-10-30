import Link from "next/link";

export function SettingsNav({ current }: { current: "configuration" | "roles" | "users" }) {
  return <nav className="panel settings-nav" aria-label="Settings navigation">
    {[
      { key: "configuration", href: "/settings", label: "CRM configuration" },
      { key: "roles", href: "/settings/access", label: "Role permissions" },
      { key: "users", href: "/settings/access/users", label: "User exceptions" },
    ].map(({ key, href, label }) => <Link key={key} href={href} className={current === key ? "selected" : undefined} aria-current={current === key ? "page" : undefined}>{label}</Link>)}
  </nav>;
}
