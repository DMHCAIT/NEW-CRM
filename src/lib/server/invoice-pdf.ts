import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { PDFDocument } from "pdf-lib";
import { buildInvoiceHtml, type InvoiceDocumentRecord } from "@/lib/invoice-document";
import { escapeHtml } from "@/lib/html";

export type InvoicePdfRecord = InvoiceDocumentRecord;

async function browserExecutable() {
  if (process.env.INVOICE_PDF_BROWSER_EXECUTABLE) return process.env.INVOICE_PDF_BROWSER_EXECUTABLE;
  if (process.platform === "linux") return chromium.executablePath();
  const candidates = process.platform === "win32" ? [
    join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  ] : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const executable = candidates.find(path => existsSync(path));
  if (!executable) throw new Error("Invoice PDF rendering requires Chrome or Edge. Set INVOICE_PDF_BROWSER_EXECUTABLE to its executable path.");
  return executable;
}

export async function buildInvoicePdf(
  invoice: InvoicePdfRecord,
  lead: { name?: string | null; email?: string | null } | null,
  paymentUrl?: string | null,
  viewUrl?: string,
) {
  if (paymentUrl && !/^https:\/\/[^\s]+$/i.test(paymentUrl))
    throw new Error("Invoice PDF payment links must use HTTPS.");
  const logo = await readFile(join(process.cwd(), "public", "DMHCA-invoice-wordmark.png"));
  const html = buildInvoiceHtml(invoice, {
    leadName: lead?.name, leadEmail: lead?.email,
    logoUrl: `data:image/png;base64,${logo.toString("base64")}`,
    paymentUrl, viewUrl,
  });
  const browser = await playwright.launch({
    executablePath: await browserExecutable(),
    args: process.platform === "linux" ? chromium.args : [],
    headless: true,
    timeout: 30_000,
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 820, height: 1160 } });
    const page = await context.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(`Invoice ${invoice.invoice_no}`)}</title><style>
html,body{margin:0;padding:0;width:820px;background:#fff}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.invoice-document>tbody,.invoice-document>tbody>tr,.invoice-document>tbody>tr>td{display:block}
.invoice-document-header,.invoice-bank-details,.invoice-terms,.invoice-document-footer{break-inside:avoid}
thead{display:table-header-group}tr{break-inside:avoid}
.invoice-document>tbody>tr{break-inside:auto}
</style></head><body>${html}</body></html>`, { waitUntil: "load", timeout: 15_000 });
    await page.emulateMedia({ media: "screen" });
    await page.locator("img").evaluateAll(images => Promise.all(images.map(image => {
      if (!(image instanceof HTMLImageElement)) throw new Error("Invalid invoice image.");
      return image.decode();
    })));
    const dimensions = await page.locator(".invoice-document").evaluate(element => ({
      width: Math.max(element.scrollWidth, element.getBoundingClientRect().width),
      height: Math.max(element.scrollHeight, element.getBoundingClientRect().height),
    }));
    const scale = Math.min((210 / 25.4 * 96 - 2) / dimensions.width, (297 / 25.4 * 96 - 2) / dimensions.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invoice PDF layout could not be measured.");
    // Chromium limits print scale to 0.1; zoom exceptionally long documents first.
    if (scale < 0.1) await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, scale / 0.1);
    const bytes = await page.pdf({
      format: "A4",
      scale: Math.max(0.1, scale),
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    const pdf = await PDFDocument.load(bytes);
    if (pdf.getPageCount() !== 1)
      throw new Error("Invoice PDF could not fit on one page. Contact finance to review the invoice content.");
    const output = pdf.getPage(0);
    const contentWidth = dimensions.width * scale * 72 / 96;
    const contentHeight = dimensions.height * scale * 72 / 96;
    const bottom = output.getHeight() - contentHeight;
    // Keep existing content/link coordinates and trim only the unused canvas.
    output.setMediaBox(0, bottom, contentWidth, contentHeight);
    output.setCropBox(0, bottom, contentWidth, contentHeight);
    return new Uint8Array(await pdf.save());
  } finally {
    await browser.close();
  }
}
