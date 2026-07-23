import {
  WALLPAPERS,
  type DesktopEntry,
  type DesktopIdentity,
  type DesktopLayout,
  type RootEntryPositionUpdate,
  type EditorLanguage,
  type EditorSettings,
  type EntryPosition,
} from "../types";
import { isBuiltinThemeId, parseCustomTheme, parseThemeState, type CustomTheme, type ThemeState } from "./themes";

const EDITOR_LANGUAGES = new Set<EditorLanguage>(["auto", "plain", "markdown", "json", "javascript", "typescript", "jsx", "tsx", "css", "html", "xml", "yaml"]);
const WALLPAPER_IDS = new Set<string>(WALLPAPERS);
const MIME_TOKEN = "[!#$%&'*+.^_`|~\\w-]+";
const MIME_TYPE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}(?:\\s*;\\s*${MIME_TOKEN}\\s*=\\s*(?:${MIME_TOKEN}|"(?:[^"\\\\]|\\\\.)*"))*\\s*$`);

export type RemoteEntry = DesktopEntry & { revision: number; contentRevision: number };
export type RemoteCustomTheme = CustomTheme & { revision: number };
export type RemoteAppearance = Omit<ThemeState, "customThemes"> & { selectionRevision: number; customThemes: RemoteCustomTheme[] };
type RemoteDesktopIdentity = DesktopIdentity & {
  schemaVersion: 1;
  catalogId: string;
  catalogRevision: number;
};

export type RemoteDesktopState = RemoteDesktopIdentity & {
  entries: RemoteEntry[];
  layout: DesktopLayout;
  layoutRevision: number;
  editorSettings: EditorSettings;
  settingsRevision: number;
  appearance: RemoteAppearance;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

export function isValidId(value: unknown): value is string {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return false;
  if (new TextEncoder().encode(value).byteLength > 180) return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function assertValidId(value: unknown, message = "An entry has an invalid ID."): asserts value is string {
  if (!isValidId(value)) throw new Error(message);
}

export function normalizeEntryName(value: string) {
  const name = value.trim();
  assertCanonicalEntryName(name);
  return name;
}

export function normalizeDesktopName(value: string) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || [...name].length > 180 || name.includes("/") || name.includes("\\") || [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })) throw new Error("A desktop has an invalid name.");
  return name;
}

export function parseDesktopIdentity(value: unknown): DesktopIdentity {
  if (!isRecord(value)) throw new Error("A desktop has an unsupported format.");
  assertValidId(value.id, "A desktop has an invalid ID.");
  return { id: value.id, name: normalizeDesktopName(typeof value.name === "string" ? value.name : "") };
}

export function parseDesktopList(value: unknown): DesktopIdentity[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("At least one desktop is required.");
  const desktops = value.map(parseDesktopIdentity);
  if (new Set(desktops.map((desktop) => desktop.id)).size !== desktops.length) throw new Error("The desktop list contains duplicate IDs.");
  return desktops;
}

export function assertCanonicalEntryName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value === "." || value === "..") {
    throw new Error("An entry has an invalid name.");
  }
  if ([...value].length > 180 || value.includes("/") || value.includes("\\") || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })) {
    throw new Error("An entry has an invalid name.");
  }
}

export function foldEntryName(value: string) {
  return value.toLowerCase();
}

function readFiniteNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function readNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(message);
  return value as number;
}

function readRequiredNullableNonNegativeInteger(value: unknown, message: string): number | null {
  if (value === undefined) throw new Error(message);
  return value === null ? null : readNonNegativeInteger(value, message);
}

export function readRevision(value: unknown, message = "A revision has an unsupported format.") {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(message);
  return value as number;
}

export function parsePosition(value: unknown): EntryPosition {
  if (!isRecord(value)) throw new Error("An entry has an invalid position.");
  return {
    x: readFiniteNumber(value.x, "An entry has an invalid position."),
    y: readFiniteNumber(value.y, "An entry has an invalid position."),
  };
}

export function parseLayout(value: unknown): DesktopLayout {
  if (!isRecord(value) || typeof value.snapToGrid !== "boolean" || typeof value.wallpaper !== "string" || !WALLPAPER_IDS.has(value.wallpaper)) {
    throw new Error("The desktop layout has an unsupported format.");
  }
  return { snapToGrid: value.snapToGrid, wallpaper: value.wallpaper as DesktopLayout["wallpaper"] };
}

export function parseRootEntryPositions(value: unknown): RootEntryPositionUpdate[] {
  if (!Array.isArray(value)) throw new Error("Root entry positions have an unsupported format.");
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("A root entry position has an unsupported format.");
    assertValidId(candidate.entryId, "A root entry position has an invalid entry ID.");
    if (ids.has(candidate.entryId)) throw new Error("Root entry positions contain duplicate entry IDs.");
    ids.add(candidate.entryId);
    return { entryId: candidate.entryId, position: parsePosition(candidate.position) };
  });
}

export function parseRootEntryPositionUpdates(value: unknown, entries: DesktopEntry[]): RootEntryPositionUpdate[] {
  const positions = parseRootEntryPositions(value);
  if (positions.length === 0) throw new Error("At least one root entry position is required.");
  const roots = new Set(entries.filter((entry) => entry.parentId === null).map((entry) => entry.id));
  if (positions.some(({ entryId }) => !roots.has(entryId))) throw new Error("Root entry positions require root entries.");
  return positions;
}

export function parseEditorSettings(value: unknown): EditorSettings {
  if (!isRecord(value) || typeof value.autoSave !== "boolean" || !Number.isInteger(value.fontSize) || (value.fontSize as number) < 11 || (value.fontSize as number) > 22 || typeof value.language !== "string" || !EDITOR_LANGUAGES.has(value.language as EditorLanguage)) {
    throw new Error("The editor settings have an unsupported format.");
  }
  if (value.lineWrap !== undefined && typeof value.lineWrap !== "boolean" || value.autoFormat !== undefined && typeof value.autoFormat !== "boolean") {
    throw new Error("The editor settings have an unsupported format.");
  }
  return {
    autoSave: value.autoSave,
    autoFormat: value.autoFormat as boolean | undefined ?? false,
    fontSize: value.fontSize as number,
    language: value.language as EditorLanguage,
    lineWrap: value.lineWrap as boolean | undefined ?? true,
  };
}

type ParsedEntry = DesktopEntry & { revision?: number; contentRevision?: number };

function parseEntry(value: unknown, remote: boolean): ParsedEntry {
  if (!isRecord(value) || (value.kind !== "file" && value.kind !== "folder")) throw new Error("An entry has an unsupported format.");
  assertValidId(value.id);
  assertCanonicalEntryName(value.name);
  if (value.parentId !== null && !isValidId(value.parentId)) throw new Error("An entry has an invalid parent ID.");
  const base = {
    kind: value.kind,
    id: value.id,
    name: value.name,
    parentId: value.parentId,
    createdAt: readRequiredNullableNonNegativeInteger(value.createdAt, "An entry has an invalid creation date."),
    modifiedAt: readNonNegativeInteger(value.modifiedAt, "An entry has an invalid modification date."),
    position: parsePosition(value.position),
  } as const;
  const revisions = remote ? {
    revision: readRevision(value.revision, "An entry has an invalid revision."),
    contentRevision: readRevision(value.contentRevision, "An entry has an invalid content revision."),
  } : {};
  if (value.kind === "folder") {
    if (value.mimeType !== undefined || value.size !== undefined) throw new Error("Folders cannot have file metadata.");
    return { ...base, kind: "folder", ...revisions };
  }
  const mimeType = readString(value.mimeType, "A file has invalid metadata.");
  if (!mimeType || mimeType.length > 255 || !MIME_TYPE.test(mimeType) || !Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new Error("A file has invalid metadata.");
  }
  return { ...base, kind: "file", mimeType, size: value.size as number, ...revisions };
}

export function parseEntries(value: unknown, remote = false): ParsedEntry[] {
  if (!Array.isArray(value)) throw new Error("The desktop entries have an unsupported format.");
  const entries = value.map((candidate) => parseEntry(candidate, remote));
  const byId = new Map<string, ParsedEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error("The desktop contains duplicate entry IDs.");
    byId.set(entry.id, entry);
  }
  const siblingNames = new Map<string, Set<string>>();
  for (const entry of entries) {
    const parentKey = entry.parentId ?? "\0";
    if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (!parent || parent.kind !== "folder") throw new Error("An entry refers to a missing parent folder.");
    }
    const names = siblingNames.get(parentKey) ?? new Set<string>();
    const folded = foldEntryName(entry.name);
    if (names.has(folded)) throw new Error(`The desktop contains duplicate entries named “${entry.name}”.`);
    names.add(folded);
    siblingNames.set(parentKey, names);

    const seen = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error("The desktop contains a folder cycle.");
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return entries;
}

export function parseRemoteDesktopState(value: unknown): RemoteDesktopState {
  if (!isRecord(value)) throw new Error("The server desktop has an unsupported format.");
  const schemaVersion = readRevision(value.schemaVersion, "The server desktop has an unsupported schema version.");
  if (schemaVersion !== 1) throw new Error("The server desktop uses an unsupported schema version.");
  assertValidId(value.catalogId, "The server desktop has an invalid catalog identity.");
  const identity = {
    schemaVersion: 1 as const,
    catalogId: value.catalogId,
    catalogRevision: readRevision(value.catalogRevision),
  };
  const layout = parseLayout(value.layout);
  if (!isRecord(value.appearance) || !Array.isArray(value.appearance.customThemes)) throw new Error("The server appearance has an unsupported format.");
  const customThemes = value.appearance.customThemes.map((candidate) => {
    const theme = parseCustomTheme(candidate);
    if (!isRecord(candidate)) throw new Error("The server appearance has an unsupported format.");
    return { ...theme, revision: readRevision(candidate.revision, "A theme has an invalid revision.") };
  });
  const appearance = parseThemeState({ selectedThemeId: value.appearance.selectedThemeId, customThemes });
  if (!isBuiltinThemeId(appearance.selectedThemeId) && !customThemes.some((theme) => theme.id === appearance.selectedThemeId)) {
    throw new Error("The selected custom theme does not exist.");
  }
  return {
    ...identity,
    id: parseDesktopIdentity(value).id,
    name: parseDesktopIdentity(value).name,
    entries: parseEntries(value.entries, true) as RemoteEntry[],
    layout,
    layoutRevision: readRevision(value.layoutRevision),
    editorSettings: parseEditorSettings(value.editorSettings),
    settingsRevision: readRevision(value.settingsRevision),
    appearance: { ...appearance, customThemes, selectionRevision: readRevision(value.appearance.selectionRevision, "The theme selection has an invalid revision.") },
  };
}
