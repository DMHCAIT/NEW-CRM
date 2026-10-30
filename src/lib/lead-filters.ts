import type { Lead } from "@/lib/types";

export type FilterField = "name" | "phone" | "email" | "country" | "course" | "qualification" | "category" | "stage" | "assignee" | "source" | "createdAt" | "modifiedAt" | "modifiedBy" | "followUpAt" | "lastVisitAt" | "untouched";
export type FilterOperator = "is" | "is_not" | "in" | "not_in" | "contains" | "not_contains" | "begins_with" | "ends_with" | "is_empty" | "is_not_empty" | "before" | "after" | "on_or_before" | "on_or_after" | "between" | "not_between" | "today" | "tomorrow" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "next_month" | "next_week" | "custom_date" | "last_days" | "next_days" | "overdue" | "is_true" | "is_false";
export type FilterCriterion = { id: string; field: FilterField; operator: FilterOperator; value: string; secondValue?: string };
export type MatchMode = "all" | "any";
export type SavedLeadFilter = { id: string; name: string; criteria: FilterCriterion[]; matchMode: MatchMode; query: string; quickView: string };

export const FILTERS_STORAGE_KEY = "northstar.leads.saved-filters";
export const FILTERS_CHANGED_EVENT = "northstar:lead-filters-changed";
export const FILTER_FIELDS: { key: FilterField; label: string; kind: "text" | "choice" | "date" | "boolean" }[] = [
  { key: "name", label: "Lead name", kind: "text" }, { key: "phone", label: "Phone", kind: "text" },
  { key: "email", label: "Email", kind: "text" }, { key: "country", label: "Country", kind: "choice" },
  { key: "course", label: "Course", kind: "choice" },
  { key: "category", label: "Category", kind: "choice" }, { key: "followUpAt", label: "Follow up", kind: "date" },
  { key: "qualification", label: "Qualification", kind: "choice" }, { key: "source", label: "Lead source", kind: "choice" },
  { key: "stage", label: "Lead stage", kind: "choice" }, { key: "assignee", label: "Assignee", kind: "choice" },
  { key: "createdAt", label: "Created", kind: "date" }, { key: "modifiedAt", label: "Modified", kind: "date" },
  { key: "modifiedBy", label: "Last Modified", kind: "choice" }, { key: "untouched", label: "Untouched", kind: "boolean" },
  { key: "lastVisitAt", label: "Most Recent Visits", kind: "date" },
];

type OperatorOption = { value: FilterOperator; label: string };
const TEXT_OPERATORS: OperatorOption[] = [
  { value: "is", label: "Is" }, { value: "is_not", label: "Is not" },
  { value: "contains", label: "Contains" }, { value: "not_contains", label: "Does not contain" },
  { value: "begins_with", label: "Starts with" }, { value: "ends_with", label: "Ends with" },
  { value: "is_empty", label: "Is empty" }, { value: "is_not_empty", label: "Is not empty" },
];
const CHOICE_OPERATORS: OperatorOption[] = [
  ...TEXT_OPERATORS.slice(0, 2), { value: "in", label: "Is any of" }, { value: "not_in", label: "Is none of" },
  ...TEXT_OPERATORS.slice(2),
];
const DATE_OPERATORS: OperatorOption[] = [
  { value: "is", label: "On" }, { value: "is_not", label: "Not on" },
  { value: "before", label: "Before" }, { value: "after", label: "After" },
  { value: "on_or_before", label: "On or before" }, { value: "on_or_after", label: "On or after" },
  { value: "between", label: "Between (inclusive)" }, { value: "not_between", label: "Not between" },
  { value: "today", label: "Today" }, { value: "yesterday", label: "Yesterday" }, { value: "tomorrow", label: "Tomorrow" },
  { value: "this_week", label: "This week" }, { value: "last_week", label: "Last week" }, { value: "next_week", label: "Next week" },
  { value: "this_month", label: "This month" }, { value: "last_month", label: "Last month" }, { value: "next_month", label: "Next month" },
  { value: "last_days", label: "In the last N days" }, { value: "next_days", label: "In the next N days" },
  { value: "custom_date", label: "Custom date" }, ...TEXT_OPERATORS.slice(-2),
];
const UNTOUCHED_OPERATORS: OperatorOption[] = [
  { value: "is_true", label: "Since creation" }, { value: "is", label: "On" },
  { value: "before", label: "Before" }, { value: "after", label: "After" },
  { value: "between", label: "Between" }, { value: "custom_date", label: "Custom date" },
];
// Kept so filters saved with the earlier "Has been edited" option still load and match.
const LEGACY_UNTOUCHED_OPERATORS: OperatorOption[] = [{ value: "is_false", label: "Has been edited" }];
const LEGACY_UNTOUCHED_RENAMES: Record<string, FilterOperator> = { untouched_before: "before", untouched_after: "after", untouched_between: "between" };
const FILTER_OPERATORS = [...TEXT_OPERATORS, ...CHOICE_OPERATORS, ...DATE_OPERATORS, ...UNTOUCHED_OPERATORS, ...LEGACY_UNTOUCHED_OPERATORS, { value: "overdue" }];
export function operatorsForField(field: FilterField): OperatorOption[] {
  const kind = FILTER_FIELDS.find(({ key }) => key === field)?.kind;
  if (kind === "boolean") return UNTOUCHED_OPERATORS;
  if (kind === "date") return field === "followUpAt" ? [...DATE_OPERATORS, { value: "overdue", label: "Overdue" }] : DATE_OPERATORS;
  return kind === "choice" ? CHOICE_OPERATORS : TEXT_OPERATORS;
}
export function operatorNeedsValue(operator: FilterOperator) {
  return !["is_empty", "is_not_empty", "today", "tomorrow", "yesterday", "this_week", "last_week", "next_week", "this_month", "last_month", "next_month", "overdue", "is_true", "is_false"].includes(operator);
}
export function defaultOperator(field: FilterField): FilterOperator {
  const kind = FILTER_FIELDS.find(({ key }) => key === field)?.kind;
  return kind === "date" ? "is" : kind === "boolean" ? "is_true" : kind === "choice" ? "is" : "contains";
}
export function isWebsiteLead(lead: Lead) {
  return ["website", "website form", "web form", "website lead", "landing page"].includes(lead.source.trim().toLocaleLowerCase());
}
export function leadIsUntouched(lead: Lead): boolean | undefined {
  if (lead.hasBeenEdited !== undefined) return !lead.hasBeenEdited;
  if (!lead.createdAt || !lead.modifiedAt) return undefined;
  const created = new Date(lead.createdAt).getTime();
  const modified = new Date(lead.modifiedAt).getTime();
  return Number.isFinite(created) && Number.isFinite(modified) ? created === modified : undefined;
}

function isCriterion(value: unknown): value is FilterCriterion {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "field" in value && FILTER_FIELDS.some(({ key }) => key === value.field)
    && "operator" in value && FILTER_OPERATORS.some((operator) => operator.value === value.operator)
    && "value" in value && typeof value.value === "string"
    && (!("secondValue" in value) || value.secondValue === undefined || typeof value.secondValue === "string");
}

export function isSavedLeadFilter(value: unknown): value is SavedLeadFilter {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string"
    && "criteria" in value && Array.isArray(value.criteria) && value.criteria.every(isCriterion)
    && "matchMode" in value && (value.matchMode === "all" || value.matchMode === "any")
    && "query" in value && typeof value.query === "string"
    && "quickView" in value && typeof value.quickView === "string";
}

export function renameLegacyUntouchedOperators(item: unknown): unknown {
  if (typeof item !== "object" || item === null || !("criteria" in item) || !Array.isArray(item.criteria)) return item;
  return { ...item, criteria: item.criteria.filter((criterion: unknown) => (
    typeof criterion !== "object" || criterion === null || !("field" in criterion) || criterion.field !== "countryCode"
  )).map((criterion: unknown) => (
    typeof criterion === "object" && criterion !== null && "operator" in criterion && typeof criterion.operator === "string" && criterion.operator in LEGACY_UNTOUCHED_RENAMES
      ? { ...criterion, operator: LEGACY_UNTOUCHED_RENAMES[criterion.operator] } : criterion)) };
}

export function readSavedLeadFilters(): SavedLeadFilter[] {
  const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Saved lead filters could not be read.");
  return parsed.map((stored: unknown) => {
    const item = renameLegacyUntouchedOperators(stored);
    if (isSavedLeadFilter(item)) return item;
    // Preserve views saved before the condition-based filter editor was introduced.
    if (typeof item === "object" && item !== null && "filters" in item
      && typeof item.filters === "object" && item.filters !== null
      && "id" in item && typeof item.id === "string" && "name" in item && typeof item.name === "string") {
      const criteria: FilterCriterion[] = [];
      for (const [field, value] of Object.entries(item.filters)) {
        if (typeof value !== "string") throw new Error("A saved lead filter has an invalid value.");
        if (!value) continue;
        if (field === "stage" || field === "course" || field === "country" || field === "assignee") {
          criteria.push({ id: `${item.id}-${field}`, field, operator: "is", value });
        } else if (field === "followUp") {
          criteria.push({ id: `${item.id}-followUp`, field: "followUpAt", operator: value === "Today" ? "today" : value === "Tomorrow" ? "tomorrow" : "is_not_empty", value: "" });
        }
      }
      return { id: item.id, name: item.name, criteria, matchMode: "all", query: "", quickView: "All accessible leads" };
    }
    throw new Error("A saved lead filter is invalid. Review your saved filters in Leads.");
  });
}

export function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateRange(operator: FilterOperator, value: string, now: Date) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (operator === "today") return [localDateKey(today), localDateKey(today)];
  if (operator === "tomorrow" || operator === "yesterday") {
    today.setDate(today.getDate() + (operator === "tomorrow" ? 1 : -1));
    return [localDateKey(today), localDateKey(today)];
  }
  if (operator === "this_week" || operator === "next_week" || operator === "last_week") {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + (operator === "next_week" ? 7 : operator === "last_week" ? -7 : 0));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return [localDateKey(monday), localDateKey(sunday)];
  }
  if (["this_month", "last_month", "next_month"].includes(operator)) {
    const offset = operator === "last_month" ? -1 : operator === "next_month" ? 1 : 0;
    return [localDateKey(new Date(today.getFullYear(), today.getMonth() + offset, 1)), localDateKey(new Date(today.getFullYear(), today.getMonth() + offset + 1, 0))];
  }
  if (operator === "last_days" || operator === "next_days") {
    const boundary = new Date(today);
    boundary.setDate(today.getDate() + (operator === "last_days" ? -1 : 1) * (Number(value) - 1));
    return operator === "last_days" ? [localDateKey(boundary), localDateKey(today)] : [localDateKey(today), localDateKey(boundary)];
  }
  return null;
}

export function criterionIsActive(criterion: FilterCriterion) {
  if (!operatorNeedsValue(criterion.operator)) return true;
  if (criterion.operator === "between" || criterion.operator === "not_between") return Boolean(criterion.value || criterion.secondValue);
  return Boolean(criterion.value.trim());
}

export function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDateKey(date) === value;
}

export function criterionError(criterion: FilterCriterion): string | null {
  const legacy = criterion.field === "untouched" && criterion.operator === "is_false";
  if (!legacy && !operatorsForField(criterion.field).some(({ value }) => value === criterion.operator)) return "Choose an operator supported by this field.";
  if (!operatorNeedsValue(criterion.operator)) return null;
  if (!criterion.value.trim()) return "Enter or choose a value.";
  if (criterion.operator === "last_days" || criterion.operator === "next_days") {
    return /^\d+$/.test(criterion.value) && Number(criterion.value) >= 1 && Number(criterion.value) <= 36500 ? null : "Enter a whole number of days from 1 to 36500.";
  }
  if (FILTER_FIELDS.find(({ key }) => key === criterion.field)?.kind === "date" || criterion.field === "untouched") {
    if (!isDateKey(criterion.value)) return "Enter a valid date.";
    if (criterion.operator === "between" || criterion.operator === "not_between") {
      if (!criterion.secondValue || !isDateKey(criterion.secondValue)) return "Enter a valid end date.";
      if (criterion.secondValue < criterion.value) return "End date must be on or after start date.";
    }
  }
  if (criterion.field === "phone" && !/\d/.test(criterion.value)) return "Enter a phone number containing digits.";
  return null;
}

function dateKey(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isDateKey(value) ? value : "";
  if (!isDateKey(value.slice(0, 10))) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? localDateKey(date) : "";
}

/** Edit dates as local date keys; `complete` is false when only the latest edit date is known. */
function leadEditDates(lead: Lead): { dates: string[]; complete: boolean } | undefined {
  if (lead.editedAt?.length) {
    const dates = lead.editedAt.map(dateKey);
    return dates.every(Boolean) ? { dates, complete: true } : undefined;
  }
  const untouched = leadIsUntouched(lead);
  if (untouched === undefined) return undefined;
  if (untouched) return { dates: [], complete: true };
  const last = lead.modifiedAt ? dateKey(lead.modifiedAt) : "";
  return last ? { dates: [last], complete: false } : undefined;
}

function leadUntouchedInPeriod(lead: Lead, criterion: FilterCriterion) {
  const created = lead.createdAt ? dateKey(lead.createdAt) : "";
  const history = leadEditDates(lead);
  if (!created || !history) return false;
  const start = criterion.value;
  // "On" and "Custom date" check a single day; "Between" checks an inclusive range.
  const end = criterion.operator === "between" ? criterion.secondValue! : start;
  // The lead must already exist for the whole period being checked.
  if (criterion.operator === "before" ? created >= start : created > start) return false;
  const latest = history.dates.reduce((max, date) => (date > max ? date : max), "");
  if (criterion.operator === "after") return history.dates.every((date) => date <= start);
  if (criterion.operator === "before") {
    if (history.dates.some((date) => date < start)) return false;
    return history.complete;
  }
  if (history.dates.some((date) => date >= start && date <= end)) return false;
  // Without full history, an older latest edit proves the range was untouched.
  return history.complete || latest < start;
}

function matchesCriterion(lead: Lead, criterion: FilterCriterion, now: Date) {
  if (criterion.field === "lastVisitAt" && (!isWebsiteLead(lead) || !lead.lastVisitAt || !dateKey(lead.lastVisitAt))) return false;
  if (criterion.field === "untouched") {
    if (criterion.operator === "is_true" || criterion.operator === "is_false") {
      const untouched = leadIsUntouched(lead);
      return untouched !== undefined && (criterion.operator === "is_true" ? untouched : !untouched);
    }
    return leadUntouchedInPeriod(lead, criterion);
  }
  const raw = lead[criterion.field];
  const actual = raw == null ? "" : String(raw);
  const expected = criterion.value.trim();
  const isDate = FILTER_FIELDS.find(({ key }) => key === criterion.field)?.kind === "date";
  const date = isDate && actual ? dateKey(actual) : "";
  if (criterion.operator === "is_empty") return isDate ? !date : actual.trim() === "";
  if (criterion.operator === "is_not_empty") return isDate ? Boolean(date) : actual.trim() !== "";
  if (isDate) {
    if (!date) return false;
    const range = dateRange(criterion.operator, expected, now);
    if (range) return date >= range[0] && date <= range[1];
    if (criterion.operator === "between" || criterion.operator === "not_between") {
      const between = date >= expected && date <= criterion.secondValue!;
      return criterion.operator === "between" ? between : !between;
    }
    if (criterion.operator === "overdue") return date < localDateKey(now);
    if (criterion.operator === "before") return date < expected;
    if (criterion.operator === "after") return date > expected;
    if (criterion.operator === "on_or_before") return date <= expected;
    if (criterion.operator === "on_or_after") return date >= expected;
    if (criterion.operator === "is_not") return date !== expected;
    return date === expected;
  }
  const isPhone = criterion.field === "phone";
  const normalized = isPhone ? actual.replace(/\D/g, "") : actual.trim().toLocaleLowerCase();
  const value = isPhone ? expected.replace(/\D/g, "") : expected.toLocaleLowerCase();
  switch (criterion.operator) {
    case "is": return normalized === value;
    case "is_not": return normalized !== value;
    case "in":
    case "not_in": {
      const included = criterion.value.split("\n").map((item) => item.trim().toLocaleLowerCase()).includes(normalized);
      return criterion.operator === "in" ? included : !included;
    }
    case "contains": return normalized.includes(value);
    case "not_contains": return !normalized.includes(value);
    case "begins_with": return normalized.startsWith(value);
    case "ends_with": return normalized.endsWith(value);
    default: return false;
  }
}

export function filterLeads(leads: Lead[], filter: Pick<SavedLeadFilter, "criteria" | "matchMode" | "query" | "quickView">, now = new Date(), options: { currentUserId?: string } = {}) {
  const search = filter.query.trim().toLocaleLowerCase();
  const phoneSearch = search.replace(/\D/g, "");
  const activeCriteria = filter.criteria.filter(criterionIsActive);
  const invalid = filter.criteria.find((criterion) => criterionError(criterion));
  if (invalid) throw new Error(`${FILTER_FIELDS.find(({ key }) => key === invalid.field)?.label}: ${criterionError(invalid)}`);
  return leads.filter((lead) => {
    const matchesQuery = !search || Object.values(lead).some((value) => String(value ?? "").toLocaleLowerCase().includes(search))
      || (phoneSearch.length > 2 && lead.phone.replace(/\D/g, "").includes(phoneSearch));
    const matchesQuickView = filter.quickView !== "My Leads" || (Boolean(options.currentUserId) && lead.assigneeId === options.currentUserId);
    const criterionMatches = filter.matchMode === "all"
      ? activeCriteria.every((criterion) => matchesCriterion(lead, criterion, now))
      : activeCriteria.length === 0 || activeCriteria.some((criterion) => matchesCriterion(lead, criterion, now));
    return !lead.isArchived && matchesQuery && matchesQuickView && criterionMatches;
  });
}
