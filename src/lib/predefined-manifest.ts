import { namesMatch, validateEntryName } from "./entry-validation";
import type { DesktopEntry, DesktopLayout, DesktopView, EditorLanguage, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "../types";

export type PredefinedFileEntry = FileEntry & { contentUrl: string };

export type PredefinedManifest = {
  version: 2;
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  entries: Array<FolderEntry | PredefinedFileEntry>;
};

const EDITOR_LANGUAGES = new Set<EditorLanguage>(["auto", "plain", "markdown", "json", "javascript", "typescript", "jsx", "tsx", "css", "html", "xml", "yaml"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertValidEditorSettings(value: unknown): asserts value is EditorSettings {
  if (
    !isRecord(value) ||
    typeof value.autoSave !== "boolean" ||
    !Number.isInteger(value.fontSize) ||
    (value.fontSize as number) < 11 ||
    (value.fontSize as number) > 22 ||
    typeof value.language !== "string" ||
    !EDITOR_LANGUAGES.has(value.language as EditorLanguage)
  ) {
    throw new Error("The predefined editor settings have an unsupported format.");
  }
}

function readLayout(value: unknown, legacy: boolean): DesktopLayout {
  if (!isRecord(value) || !Number.isInteger(value.columns) || (value.columns as number) < 1 || !Array.isArray(value.views) || value.views.length < 1) {
    throw new Error("The predefined desktop layout has an unsupported format.");
  }
  if (!legacy && typeof value.snapToGrid !== "boolean") {
    throw new Error("The predefined desktop layout has an unsupported format.");
  }
  const ids = new Set<string>();
  for (const view of value.views) {
    if (!isRecord(view) || typeof view.id !== "string" || !view.id || ids.has(view.id)) {
      throw new Error("The predefined desktop layout has an unsupported format.");
    }
    ids.add(view.id);
  }
  if ((value.columns as number) > value.views.length) {
    throw new Error("The predefined desktop has more columns than views.");
  }
  return {
    views: value.views as DesktopView[],
    columns: value.columns as number,
    snapToGrid: legacy ? false : value.snapToGrid as boolean,
  };
}

function readPosition(value: unknown): EntryPosition {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    value.x < 0 ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    value.y < 0
  ) {
    throw new Error("A predefined entry has an invalid position.");
  }
  return { x: value.x, y: value.y };
}

export function parsePredefinedManifest(value: unknown): PredefinedManifest {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.entries)) {
    throw new Error("The predefined desktop manifest has an unsupported format.");
  }
  const layout = readLayout(value.layout, value.version === 1);
  assertValidEditorSettings(value.editorSettings);

  const viewIds = new Set(layout.views.map((view) => view.id));
  const byId = new Map<string, FolderEntry | PredefinedFileEntry>();

  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== "file" && candidate.kind !== "folder") ||
      typeof candidate.id !== "string" ||
      !candidate.id ||
      candidate.id === "." ||
      candidate.id === ".." ||
      candidate.id.includes("/") ||
      candidate.id.includes("\\") ||
      [...candidate.id].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error("A predefined entry has an unsupported format.");
    }
    if (byId.has(candidate.id)) throw new Error("The predefined desktop contains duplicate entry IDs.");
    if (typeof candidate.name !== "string" || validateEntryName(candidate.name) !== candidate.name) {
      throw new Error("A predefined entry has an invalid name.");
    }
    if (candidate.parentId !== null && typeof candidate.parentId !== "string") {
      throw new Error("A predefined entry has an invalid parent ID.");
    }
    if (candidate.viewId !== null && typeof candidate.viewId !== "string") {
      throw new Error("A predefined entry has an invalid view ID.");
    }
    if (typeof candidate.modifiedAt !== "number" || !Number.isFinite(candidate.modifiedAt) || candidate.modifiedAt < 0) {
      throw new Error("A predefined entry has an invalid modification date.");
    }
    const position = readPosition(candidate.position);

    if (candidate.kind === "file") {
      if (
        typeof candidate.mimeType !== "string" ||
        !candidate.mimeType ||
        typeof candidate.size !== "number" ||
        !Number.isInteger(candidate.size) ||
        candidate.size < 0 ||
        typeof candidate.contentUrl !== "string" ||
        !candidate.contentUrl
      ) {
        throw new Error("A predefined file has unsupported metadata.");
      }
      byId.set(candidate.id, {
        kind: "file",
        id: candidate.id,
        name: candidate.name,
        parentId: candidate.parentId,
        viewId: candidate.viewId,
        modifiedAt: candidate.modifiedAt,
        position,
        mimeType: candidate.mimeType,
        size: candidate.size,
        contentUrl: candidate.contentUrl,
      });
    } else {
      byId.set(candidate.id, {
        kind: "folder",
        id: candidate.id,
        name: candidate.name,
        parentId: candidate.parentId,
        viewId: candidate.viewId,
        modifiedAt: candidate.modifiedAt,
        position,
      });
    }
  }

  const siblings = new Map<string | null, DesktopEntry[]>();
  for (const entry of byId.values()) {
    if (entry.parentId === null && !viewIds.has(entry.viewId ?? "")) {
      throw new Error("The predefined desktop refers to a missing view.");
    }
    if (entry.parentId !== null && entry.viewId !== null) {
      throw new Error("Predefined entries inside folders cannot belong to a desktop view.");
    }
    if (entry.parentId === entry.id) throw new Error("The predefined desktop contains a folder cycle.");
    if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (!parent) throw new Error("The predefined desktop refers to a missing parent folder.");
      if (parent.kind !== "folder") throw new Error("A predefined file cannot contain other entries.");
    }

    const siblingEntries = siblings.get(entry.parentId) ?? [];
    if (siblingEntries.some((candidate) => namesMatch(candidate.name, entry.name))) {
      throw new Error(`The predefined desktop contains duplicate entries named “${entry.name}”.`);
    }
    siblingEntries.push(entry);
    siblings.set(entry.parentId, siblingEntries);

    const visited = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error("The predefined desktop contains a folder cycle.");
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  return {
    version: 2,
    layout,
    editorSettings: value.editorSettings,
    entries: [...byId.values()],
  };
}
