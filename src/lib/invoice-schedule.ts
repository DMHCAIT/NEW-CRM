export function invoiceDateToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function scheduledInvoiceTime(date: string) {
  return new Date(`${date}T09:00:00+05:30`).toISOString();
}

export function scheduledDueDate(date: string) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 4 * 86400000).toISOString().slice(0, 10);
}

export function installmentLabel(number: number) {
  const lastTwo = number % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[number % 10] ?? "th");
  return `${number}${suffix} installment`;
}
