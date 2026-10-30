import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./modules.css";
import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/server/auth";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "DMHCA CRM",
  description: "Role-aware lead management for admissions teams.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppShell user={user}>{children}</AppShell>
      </body>
    </html>
  );
}
