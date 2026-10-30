import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";
import { smtpTransport } from "@/lib/server/smtp-transport";

export type MailAttachment = { filename: string; content: Buffer | Uint8Array; contentType?: string };

export async function sendMail(options: {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  attachments?: MailAttachment[];
}) {
  const config = await getIntegrationConfig("smtp");
  const from = requireIntegrationValue(config, "SMTP_FROM");
  const transporter = await smtpTransport(config);
  try {
  const info = await transporter.sendMail({
    from: options.fromName ? { name: options.fromName, address: extractAddress(from) } : from,
    to: options.to,
    cc: options.cc,
    replyTo: options.replyTo,
    subject: options.subject,
    html: options.html,
    text: options.text ?? htmlToText(options.html),
    attachments: options.attachments?.map(({ filename, content, contentType }) => ({ filename, content: Buffer.from(content), contentType })),
  });
  if (Array.isArray(info.rejected) && info.rejected.length) throw new Error("SMTP server rejected the recipient.");
  return info.messageId as string;
  } finally { transporter.close(); }
}

function extractAddress(from: string) {
  const match = /<([^>]+)>/.exec(from);
  return match ? match[1] : from;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function htmlToText(html: string) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export function emailLayout(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#EEF3FB;font-family:Inter,Arial,sans-serif;color:#1F2937">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #C9D3E3;border-radius:8px">
<tr><td style="background:#0A1A3F;color:#fff;padding:16px 24px;font-size:18px;font-weight:600;border-radius:8px 8px 0 0">DMHCA · ${escapeHtml(title)}</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:20px">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Converts plain text typed by a user into safe HTML paragraphs. */
export function textToHtml(text: string) {
  return text.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}
