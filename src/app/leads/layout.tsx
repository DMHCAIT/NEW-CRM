import "./leads.css";
import { Suspense } from "react";
import { SectionLoading } from "@/components/section-loading";

export default function LeadsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<SectionLoading title="Leads" />}>{children}</Suspense>;
}
