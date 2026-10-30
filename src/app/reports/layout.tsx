"use client";

import { ReportsDataProvider } from "@/components/reports-data-provider";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <ReportsDataProvider>{children}</ReportsDataProvider>;
}
