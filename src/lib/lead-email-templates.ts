export type LeadEmailInvoice = { id: string; invoiceNo: string; course: string; amount: number; currency: string; dueDate: string; status: string };
export type LeadEmailTemplateId = "enquiry" | "follow-up" | "invoice";
export const leadEmailTemplates: { id: LeadEmailTemplateId; name: string; description: string }[] = [
  { id: "enquiry", name: "Course enquiry", description: "Introduce yourself and the program" },
  { id: "follow-up", name: "Follow-up", description: "Reconnect after an earlier email" },
  { id: "invoice", name: "Invoice reminder", description: "Use a selected lead invoice" },
];

export function createLeadEmailDraft(id: LeadEmailTemplateId, context: {
  doctor: string; course: string; sender: string; phone: string; invoice?: LeadEmailInvoice;
}) {
  const doctor = context.doctor.replace(/^Dr\.?\s+/i, "").trim();
  if (!doctor) throw new Error("Add the lead's name before using a template.");
  const course = (id === "invoice" ? context.invoice?.course || context.course : context.course).trim();
  if (!course) throw new Error("Add a course to this lead before using this template.");
  const greeting = `Dear Dr. ${doctor},`;
  if (id === "enquiry") return {
    subject: `Your enquiry about ${course} – DMHCA`,
    body: `${greeting}\n\nGreetings from DMHCA!\n\nThank you for your interest in the ${course}. I'm ${context.sender}, your admission counsellor, and I'll be guiding you through the program details, eligibility and the admission process.\n\nThe program is delivered online and is designed for practising clinicians, so it fits around your clinic or hospital schedule.\n\nCould you share a convenient time for a short call, or reply with any questions you have? I'm happy to help in whichever way suits you.\n\nWarm regards,`,
  };
  if (id === "follow-up") return {
    subject: `Following up on ${course} – DMHCA`,
    body: `${greeting}\n\nI wanted to follow up on my earlier email, in case it got buried in a busy inbox.\n\nOn a short call, I can walk you through:\n\n- Eligibility and the admission process\n- Program structure, duration and schedule\n- Fee and payment options\n\nIf email is easier for you, just reply with your questions and I'll answer them right here.\n\nWarm regards,`,
  };
  const invoice = context.invoice;
  if (!invoice) throw new Error("Select an invoice for this lead before using the invoice reminder.");
  if (["paid", "cancelled", "rejected"].includes(invoice.status)) throw new Error("Choose an unpaid, active invoice for a payment reminder.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.dueDate) || !Number.isFinite(invoice.amount) || invoice.amount <= 0)
    throw new Error("This invoice is missing a valid due date or amount.");
  const date = new Date(`${invoice.dueDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== invoice.dueDate) throw new Error("This invoice has an invalid due date.");
  const due = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  const amount = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(invoice.amount);
  const phone = context.phone.trim();
  return {
    subject: `Reminder: Invoice ${invoice.invoiceNo} for ${course} – due ${due}`,
    body: `${greeting}\n\nGreetings from DMHCA.\n\nThis is a gentle reminder that invoice ${invoice.invoiceNo} for the ${course}, amount ${invoice.currency === "INR" ? "Rs." : invoice.currency} ${amount}, is due on ${due}.\n\nYou can pay securely using the Pay Now button in the invoice email, or by bank transfer using the details on the invoice.\n\nIf you have already paid, please share the transaction reference so I can update our records, and please ignore this reminder. If you'd like to discuss payment options or have any questions, just reply here${phone ? ` or call me on ${phone.startsWith("+") ? phone : `+91 ${phone}`}` : ""}.\n\nWarm regards,`,
  };
}
