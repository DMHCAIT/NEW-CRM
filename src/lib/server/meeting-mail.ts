import { appUrl } from "@/lib/server/env";
import { emailLayout, escapeHtml, sendMail } from "@/lib/server/mailer";

export type MeetingInvite = {
  id: string;
  title: string;
  start_at: string;
  duration_min: number;
  join_url: string | null;
  passcode?: string | null;
};
export type MeetingRecipient = { email: string; name: string };

function icsEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}
function utcStamp(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function foldIcsLine(line: string) {
  const chars = Array.from(line);
  const chunks: string[] = [];
  while (chars.length) chunks.push(chars.splice(0, chunks.length ? 74 : 75).join(""));
  return chunks.join("\r\n ");
}

export function buildMeetingIcs(meeting: MeetingInvite, method: "REQUEST" | "CANCEL", sequence: number) {
  const start = new Date(meeting.start_at);
  const end = new Date(start.getTime() + meeting.duration_min * 60_000);
  const domain = new URL(appUrl()).hostname;
  const lines = [
    "BEGIN:VCALENDAR", "PRODID:-//DMHCA CRM//Internal Meetings//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT", `UID:${meeting.id}@${domain}`, `DTSTAMP:${utcStamp(new Date())}`, `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`,
    `SEQUENCE:${sequence}`, `SUMMARY:${icsEscape(meeting.title)}`,
    ...(meeting.join_url ? [`DESCRIPTION:${icsEscape(`Join Zoom: ${meeting.join_url}${meeting.passcode ? ` Passcode: ${meeting.passcode}` : ""}`)}`, `URL:${meeting.join_url}`] : []),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export async function emailMeetingRecipients(meeting: MeetingInvite, recipients: MeetingRecipient[], hostName: string, method: "REQUEST" | "CANCEL" = "REQUEST", sequence = 0) {
  let emailed = 0;
  const failures: string[] = [];
  const localDate = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short", hour12: true,
  }).format(new Date(meeting.start_at));
  const cancelled = method === "CANCEL";
  const subject = `${cancelled ? "Cancelled" : sequence ? "Updated" : "Invitation"}: ${meeting.title}`;
  const safeTitle = escapeHtml(meeting.title);
  const joinHtml = meeting.join_url && !cancelled
    ? `<p><a href="${escapeHtml(meeting.join_url)}">Join Zoom meeting</a>${meeting.passcode ? `<br>Passcode: ${escapeHtml(meeting.passcode)}` : ""}</p>`
    : "";
  const ics = Buffer.from(buildMeetingIcs(meeting, method, sequence), "utf8");
  for (const recipient of recipients) {
    try {
      await sendMail({
        to: recipient.email,
        subject,
        html: emailLayout(cancelled ? "Meeting cancelled" : "Internal meeting", `<p>Hello ${escapeHtml(recipient.name)},</p><p>${cancelled ? `The meeting <strong>${safeTitle}</strong> has been cancelled.` : `You are invited to <strong>${safeTitle}</strong>.`}</p><p>${cancelled ? "" : `${escapeHtml(localDate)} · ${meeting.duration_min} minutes<br>Host: ${escapeHtml(hostName)}`}</p>${joinHtml}`),
        text: `${cancelled ? "Meeting cancelled" : `Internal meeting: ${meeting.title}`}\n${localDate}\nHost: ${hostName}${meeting.join_url && !cancelled ? `\nJoin: ${meeting.join_url}${meeting.passcode ? `\nPasscode: ${meeting.passcode}` : ""}` : ""}`,
        attachments: [{ filename: "meeting.ics", content: ics, contentType: `text/calendar; method=${method}; charset=UTF-8` }],
      });
      emailed++;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Email delivery failed.");
    }
  }
  return { emailed, emailError: failures.length ? failures[0] : undefined };
}
