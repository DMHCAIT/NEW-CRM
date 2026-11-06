import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  outputFileTracingIncludes: {
    "/api/invoices/**": ["./public/DMHCA-invoice-logo.png", "./public/IBMP-logo.png"],
    "/api/webhooks/**": ["./public/DMHCA-invoice-logo.png", "./public/IBMP-logo.png"],
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
