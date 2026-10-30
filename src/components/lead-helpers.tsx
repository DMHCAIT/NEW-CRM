export function stageBadgeClass(stage: string) {
  return stage === "Closed Won" || stage === "Already Enrolled"
    ? "pill-green"
    : ["Closed Lost", "Hot", "DND", "Junk", "Not Interested"].includes(stage)
      ? "pill-red"
      : ["Warm", "Prospect", "Reactivated", "Interested – No Course", "Interested – No Centre"].includes(stage)
        ? "pill-violet"
        : ["Future Prospect", "Not Eligible"].includes(stage)
          ? "pill-amber"
          : "pill-blue";
}

export function StageBadge({ stage }: { stage: string }) {
  return <span className={`status-pill ${stageBadgeClass(stage)}`}>{stage}</span>;
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("");
}
