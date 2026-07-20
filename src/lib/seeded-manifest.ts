import { namesMatch, validateEntryName } from "./entry-validation";
import { DEFAULT_WALLPAPER, WALLPAPERS, type DesktopEntry, type DesktopLayout, type DesktopView, type EditorLanguage, type EditorSettings, type EntryPosition, type FileEntry, type FolderEntry, type Wallpaper } from "../types";

export type SeededFileEntry = FileEntry & { contentUrl: string };

export type SeededManifest = {
  version: 3;
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  entries: Array<FolderEntry | SeededFileEntry>;
};

const EDITOR_LANGUAGES = new Set<EditorLanguage>(["auto", "plain", "markdown", "json", "javascript", "typescript", "jsx", "tsx", "css", "html", "xml", "yaml"]);
const WALLPAPER_IDS = new Set<Wallpaper>(WALLPAPERS);

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
    throw new Error("The seeded editor settings have an unsupported format.");
  }
}

function readLayout(value: unknown, version: number): DesktopLayout {
  if (!isRecord(value) || !Number.isInteger(value.columns) || (value.columns as number) < 1 || !Array.isArray(value.views) || value.views.length < 1) {
    throw new Error("The seeded desktop layout has an unsupported format.");
  }
  if (version > 1 && typeof value.snapToGrid !== "boolean") {
    throw new Error("The seeded desktop layout has an unsupported format.");
  }
  if (version > 2 && (typeof value.wallpaper !== "string" || !WALLPAPER_IDS.has(value.wallpaper as Wallpaper))) {
    throw new Error("The seeded desktop layout has an unsupported format.");
  }
  const ids = new Set<string>();
  for (const view of value.views) {
    if (!isRecord(view) || typeof view.id !== "string" || !view.id || ids.has(view.id)) {
      throw new Error("The seeded desktop layout has an unsupported format.");
    }
    ids.add(view.id);
  }
  if ((value.columns as number) > value.views.length) {
    throw new Error("The seeded desktop has more columns than views.");
  }
  return {
    views: value.views as DesktopView[],
    columns: value.columns as number,
    snapToGrid: version === 1 ? false : value.snapToGrid as boolean,
    wallpaper: version < 3 ? DEFAULT_WALLPAPER : value.wallpaper as Wallpaper,
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
    throw new Error("A seeded entry has an invalid position.");
  }
  return { x: value.x, y: value.y };
}

export function parseSeededManifest(value: unknown): SeededManifest {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.entries)) {
    throw new Error("The seeded desktop manifest has an unsupported format.");
  }
  const layout = readLayout(value.layout, value.version);
  assertValidEditorSettings(value.editorSettings);

  const viewIds = new Set(layout.views.map((view) => view.id));
  const byId = new Map<string, FolderEntry | SeededFileEntry>();

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
      throw new Error("A seeded entry has an unsupported format.");
    }
    if (byId.has(candidate.id)) throw new Error("The seeded desktop contains duplicate entry IDs.");
    if (typeof candidate.name !== "string" || validateEntryName(candidate.name) !== candidate.name) {
      throw new Error("A seeded entry has an invalid name.");
    }
    if (candidate.parentId !== null && typeof candidate.parentId !== "string") {
      throw new Error("A seeded entry has an invalid parent ID.");
    }
    if (candidate.viewId !== null && typeof candidate.viewId !== "string") {
      throw new Error("A seeded entry has an invalid view ID.");
    }
    if (typeof candidate.modifiedAt !== "number" || !Number.isFinite(candidate.modifiedAt) || candidate.modifiedAt < 0) {
      throw new Error("A seeded entry has an invalid modification date.");
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
        throw new Error("A seeded file has unsupported metadata.");
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
      throw new Error("The seeded desktop refers to a missing view.");
    }
    if (entry.parentId !== null && entry.viewId !== null) {
      throw new Error("Seeded entries inside folders cannot belong to a desktop view.");
    }
    if (entry.parentId === entry.id) throw new Error("The seeded desktop contains a folder cycle.");
    if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (!parent) throw new Error("The seeded desktop refers to a missing parent folder.");
      if (parent.kind !== "folder") throw new Error("A seeded file cannot contain other entries.");
    }

    const siblingEntries = siblings.get(entry.parentId) ?? [];
    if (siblingEntries.some((candidate) => namesMatch(candidate.name, entry.name))) {
      throw new Error(`The seeded desktop contains duplicate entries named “${entry.name}”.`);
    }
    siblingEntries.push(entry);
    siblings.set(entry.parentId, siblingEntries);

    const visited = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error("The seeded desktop contains a folder cycle.");
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  return {
    version: 3,
    layout,
    editorSettings: value.editorSettings,
    entries: [...byId.values()],
  };
}
