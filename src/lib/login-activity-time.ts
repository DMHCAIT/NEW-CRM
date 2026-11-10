const formatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatLoginActivityTime(value: string) {
  return `${formatter.format(new Date(value))} IST`;
}
