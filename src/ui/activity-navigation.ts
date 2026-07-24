import type { ActivityRecord } from "../lib/activity";
import type { DesktopEntry } from "../types";

type ActivityWithEntryIds = ActivityRecord & {
  entryId?: unknown;
  entryIds?: unknown;
};

export function activityEntryIds(activity: ActivityRecord) {
  const candidate = activity as ActivityWithEntryIds;
  const values = [candidate.entryId, ...(Array.isArray(candidate.entryIds) ? candidate.entryIds : [])];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

export function canOpenActivity(activity: ActivityRecord, currentDesktopId: string, entries: readonly DesktopEntry[], desktopIds: readonly string[]) {
  if ("broken" in activity || !activity.desktopId || activityEntryIds(activity).length === 0) return false;
  if (activity.desktopId !== currentDesktopId) return desktopIds.includes(activity.desktopId);
  const entryIds = new Set(entries.map((entry) => entry.id));
  return activityEntryIds(activity).some((id) => entryIds.has(id));
}
