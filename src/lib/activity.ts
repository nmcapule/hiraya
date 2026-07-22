import { isRecord } from "./contracts";

export const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
export const MAX_ACTIVITY_PAGE_LIMIT = 100;
export const MAX_ACTIVITY_QUERY_LENGTH = 200;

export type ActivityRecord = {
  revision: number;
  action: string;
  source: string;
  timestamp: number;
  summary: string;
  details: string[];
};

export type ActivityPage = {
  activities: ActivityRecord[];
  nextBefore: number | null;
};

export type ActivityQuery = {
  q?: string;
  before?: number;
  limit?: number;
};

export type NewActivityRecord = Omit<ActivityRecord, "revision">;

function positiveInteger(value: unknown, message: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(message);
  return value as number;
}

function parseRecord(value: unknown): ActivityRecord {
  if (!isRecord(value) || typeof value.action !== "string" || !value.action.trim() || value.action.length > 120 || typeof value.source !== "string" || !value.source.trim() || value.source.length > 120 || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 500 || !Array.isArray(value.details)) {
    throw new Error("An activity record has an unsupported format.");
  }
  const details = value.details.map((detail) => {
    if (typeof detail !== "string" || !detail.trim() || detail.length > 500) throw new Error("An activity record has invalid details.");
    return detail;
  });
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) throw new Error("An activity record has an invalid timestamp.");
  return {
    revision: positiveInteger(value.revision, "An activity record has an invalid revision."),
    action: value.action,
    source: value.source,
    timestamp: value.timestamp as number,
    summary: value.summary,
    details,
  };
}

export function parseActivityPage(value: unknown): ActivityPage {
  if (!isRecord(value) || !Array.isArray(value.activities)) throw new Error("The activity response has an unsupported format.");
  const activities = value.activities.map(parseRecord);
  if (activities.some((record, index) => index > 0 && record.revision >= activities[index - 1].revision)) {
    throw new Error("The activity response is not in newest-first order.");
  }
  const nextBefore = value.nextBefore === null ? null : positiveInteger(value.nextBefore, "The activity response has an invalid cursor.");
  if (nextBefore !== null && activities.length > 0 && nextBefore > activities.at(-1)!.revision) throw new Error("The activity response has an invalid cursor.");
  return { activities, nextBefore };
}

export function parseActivityQuery(value: ActivityQuery = {}): Required<Pick<ActivityQuery, "limit">> & Omit<ActivityQuery, "limit"> {
  if (value.q !== undefined && typeof value.q !== "string") throw new Error("The activity search has an unsupported format.");
  const q = value.q?.trim();
  if (q && q.length > MAX_ACTIVITY_QUERY_LENGTH) throw new Error(`The activity search must not exceed ${MAX_ACTIVITY_QUERY_LENGTH} characters.`);
  const before = value.before === undefined ? undefined : positiveInteger(value.before, "The activity cursor has an unsupported format.");
  const limit = positiveInteger(value.limit ?? DEFAULT_ACTIVITY_PAGE_LIMIT, "The activity page limit must be a positive integer.");
  if (limit > MAX_ACTIVITY_PAGE_LIMIT) throw new Error(`The activity page limit must not exceed ${MAX_ACTIVITY_PAGE_LIMIT}.`);
  return { ...(q ? { q } : {}), ...(before === undefined ? {} : { before }), limit };
}

function localAction(summary: string) {
  if (summary.startsWith("Created custom theme")) return "theme-create";
  if (/^(Created|Pasted)/.test(summary)) return "create";
  if (summary.startsWith("Imported")) return "import";
  if (summary.startsWith("Renamed")) return "rename";
  if (/^(Moved desktop|Arranged desktop)/.test(summary)) return "positions";
  if (summary.startsWith("Moved")) return "move";
  if (summary.startsWith("Deleted custom theme")) return "theme-delete";
  if (summary.startsWith("Deleted")) return "delete";
  if (summary.startsWith("Edited")) return "content";
  if (summary.startsWith("Changed editor")) return "settings";
  if (summary.startsWith("Changed desktop")) return "layout";
  if (summary.startsWith("Selected theme")) return "theme-selection";
  if (summary.startsWith("Updated custom theme")) return "theme-update";
  return "update";
}

export function activityRecord(summary: string, details: string[], timestamp = Date.now(), action = localAction(summary)): NewActivityRecord {
  const { revision: _revision, ...record } = parseRecord({ revision: 1, action, source: "frontend", timestamp, summary, details });
  void _revision;
  return record;
}
