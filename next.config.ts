import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  onDemandEntries: {
    maxInactiveAge: 15 * 60 * 1000,
    pagesBufferLength: 8,
  },
  experimental: {
    staleTimes: { dynamic: 30, static: 30 },
  },
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/api/invoices/**": ["./public/DMHCA-invoice-wordmark.png", "./public/IBMP-logo.png", "./node_modules/@sparticuz/chromium/bin/**"],
    "/api/webhooks/**": ["./public/DMHCA-invoice-wordmark.png", "./public/IBMP-logo.png", "./node_modules/@sparticuz/chromium/bin/**"],
    "/api/cron/invoices": ["./public/DMHCA-invoice-wordmark.png", "./public/IBMP-logo.png", "./node_modules/@sparticuz/chromium/bin/**"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
});

export default nextConfig;
