export type InstallmentPaymentSummary = {
  courseTotal: number;
  paidToDate: number;
  outstanding: number;
  balanceAfterPayment: number;
  schedule: { number: number; amount: number; dueDate: string | null; status: string; current: boolean }[];
};
type FamilyInvoice = {
  id: string; total: number | string; status: string; installment_number?: number | null; due_date?: string | null; created_at?: string;
};

export function installmentPaymentSummary(courseTotal: number | string, current: FamilyInvoice, family: FamilyInvoice[]): InstallmentPaymentSummary {
  const cents = (value: number | string) => Math.round(Number(value) * 100);
  const total = cents(courseTotal);
  const paid = family.filter(row => row.status === "paid").reduce((sum, row) => sum + cents(row.total), 0);
  const outstanding = Math.max(0, total - paid);
  const currentStatus = family.find(row => row.id === current.id)?.status ?? current.status;
  const payable = !["paid", "cancelled", "rejected"].includes(currentStatus) ? cents(current.total) : 0;
  return {
    courseTotal: total / 100, paidToDate: paid / 100, outstanding: outstanding / 100,
    balanceAfterPayment: Math.max(0, outstanding - payable) / 100,
    schedule: [...family].sort((a, b) => (a.installment_number ?? 0) - (b.installment_number ?? 0) || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id))
      .map((row, index) => ({ number: row.installment_number ?? index + 1, amount: cents(row.total) / 100, dueDate: row.due_date ?? null, status: row.status, current: row.id === current.id })),
  };
}
