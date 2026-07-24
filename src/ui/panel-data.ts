import type { OutboxOperation, OutboxRecord } from "../lib/outbox";

export const SEARCH_CATEGORIES = ["files", "folders", "windows", "commands"] as const;
export type SearchCategory = typeof SEARCH_CATEGORIES[number];

export type SearchItem = {
  id: string;
  category: SearchCategory;
  label: string;
  detail?: string;
  keywords?: readonly string[];
};

export type SearchGroup<T extends SearchItem = SearchItem> = {
  category: SearchCategory;
  items: T[];
};

export function filterAndGroupSearchItems<T extends SearchItem>(items: readonly T[], query: string): SearchGroup<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  const matching = terms.length === 0 ? items : items.filter((item) => {
    const searchable = [item.label, item.detail, ...(item.keywords ?? [])].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });

  return SEARCH_CATEGORIES.flatMap((category) => {
    const categoryItems = matching.filter((item) => item.category === category).sort((left, right) => {
      if (!normalized) return 0;
      const rank = (item: SearchItem) => {
        const label = item.label.toLocaleLowerCase();
        return label === normalized ? 0 : label.startsWith(normalized) ? 1 : 2;
      };
      return rank(left) - rank(right);
    });
    return categoryItems.length > 0 ? [{ category, items: categoryItems }] : [];
  });
}

export function selectedRenderedItem<T>(items: readonly T[], activeIndex: number) {
  return items.length ? items[Math.min(Math.max(0, activeIndex), items.length - 1)] : undefined;
}

export type KeyboardShortcut = {
  id: string;
  group: string;
  label: string;
  keys: readonly string[];
  keywords?: readonly string[];
};

export type ShortcutGroup = { label: string; shortcuts: KeyboardShortcut[] };

export function filterAndGroupShortcuts(shortcuts: readonly KeyboardShortcut[], query: string): ShortcutGroup[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, KeyboardShortcut[]>();

  for (const shortcut of shortcuts) {
    const searchable = [shortcut.group, shortcut.label, ...shortcut.keys, ...(shortcut.keywords ?? [])].join(" ").toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) continue;
    groups.set(shortcut.group, [...(groups.get(shortcut.group) ?? []), shortcut]);
  }

  return Array.from(groups, ([label, groupedShortcuts]) => ({ label, shortcuts: groupedShortcuts }));
}

export type WindowListItem = {
  id: string;
  title: string;
  areaId: string;
  areaLabel: string;
  minimized?: boolean;
};

export type WindowAreaGroup = { id: string; label: string; windows: WindowListItem[] };

export function groupWindowsByArea(windows: readonly WindowListItem[]): WindowAreaGroup[] {
  const groups = new Map<string, WindowAreaGroup>();
  for (const window of windows) {
    const group = groups.get(window.areaId);
    if (group) group.windows.push(window);
    else groups.set(window.areaId, { id: window.areaId, label: window.areaLabel, windows: [window] });
  }
  return Array.from(groups.values());
}

const OPERATION_LABELS: Record<OutboxOperation["kind"], string> = {
  "create-desktop": "Create desktop",
  "rename-desktop": "Rename desktop",
  "delete-desktop": "Delete desktop",
  create: "Create items",
  "update-entry": "Update item",
  delete: "Delete item",
  "delete-entries": "Delete items",
  "move-entries": "Move items",
  "entry-transfer": "Move items between desktops",
  "save-content": "Save file",
  "root-entry-positions": "Arrange desktop items",
  layout: "Update desktop layout",
  "editor-settings": "Update editor settings",
  "select-theme": "Select theme",
  "upsert-theme": "Save theme",
  "delete-theme": "Delete theme",
};

export function outboxRecordLabel(record: Pick<OutboxRecord, "operation">) {
  return OPERATION_LABELS[record.operation.kind];
}

export function partitionSyncRecords(records: readonly OutboxRecord[]) {
  return {
    blocked: records.filter((record) => record.status === "blocked"),
    pending: records.filter((record) => record.status === "pending"),
  };
}
