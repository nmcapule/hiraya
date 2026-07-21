import { DEFAULT_WALLPAPER, type DesktopEntry, type DesktopLayout, type EditorSettings, type FileEntry, type FolderEntry } from "../types";
import { isRecord, parseEditorSettings, parseEntries, parseLayout } from "./contracts";
import { decodeManifest, emptySyncState, manifestLayout } from "./manifest-codec";

declare const portableContentUrl: unique symbol;
declare const bundledContentUrl: unique symbol;
export type PortableContentUrl = string & { readonly [portableContentUrl]: true };
export type BundledContentUrl = string & { readonly [bundledContentUrl]: true };

export type PortableSeededFileEntry = FileEntry & { contentUrl: PortableContentUrl };
export type PortableSeededManifest = {
  version: 4;
  layout: DesktopLayout;
  editorSettings: EditorSettings;
  entries: Array<FolderEntry | PortableSeededFileEntry>;
};

// Build-time asset imports replace portable relative paths with browser URLs.
export type BundledSeededFileEntry = FileEntry & { contentUrl: BundledContentUrl };
export type BundledSeededManifest = Omit<PortableSeededManifest, "entries"> & {
  entries: Array<FolderEntry | BundledSeededFileEntry>;
};

// Kept for the existing application-facing virtual module API.
export type SeededFileEntry = BundledSeededFileEntry;
export type SeededManifest = BundledSeededManifest;

function readSeeded(value: unknown, portable: boolean): PortableSeededManifest {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) || !Array.isArray(value.entries)) {
    throw new Error("The seeded desktop manifest has an unsupported format.");
  }
  if (!isRecord(value.layout)) throw new Error("The seeded desktop layout has an unsupported format.");
  const editorSettings = parseEditorSettings(value.editorSettings);
  const contentUrls = new Map<string, PortableContentUrl>();
  const plainEntries = value.entries.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("A seeded entry has an unsupported format.");
    if (candidate.kind === "file") {
      if (typeof candidate.contentUrl !== "string" || !candidate.contentUrl) throw new Error("A seeded file has unsupported metadata.");
      if (portable) assertPortableContentUrl(candidate.contentUrl);
      contentUrls.set(String(candidate.id), candidate.contentUrl as PortableContentUrl);
    }
    const { contentUrl: _contentUrl, ...entry } = candidate;
    void _contentUrl;
    return entry;
  });
  let layout: DesktopLayout;
  let parsedEntries: DesktopEntry[];
  if (value.version === 4) {
    layout = parseLayout(value.layout);
    parsedEntries = parseEntries(plainEntries, layout);
  } else {
    const migrated = decodeManifest({
      version: 9,
      entries: plainEntries,
      views: value.layout.views,
      viewColumns: value.layout.columns,
      snapToGrid: value.version === 1 ? false : value.layout.snapToGrid,
      wallpaper: value.version < 3 ? DEFAULT_WALLPAPER : value.layout.wallpaper,
      editorSettings,
      sync: emptySyncState(),
    }, { x: 1, y: 1 }, () => "unused");
    layout = manifestLayout(migrated.manifest);
    parsedEntries = migrated.manifest.entries;
  }
  const entries = parsedEntries.map((entry) => entry.kind === "file"
    ? { ...entry, contentUrl: contentUrls.get(entry.id) as string }
    : entry) as Array<FolderEntry | PortableSeededFileEntry>;
  return { version: 4, layout, editorSettings, entries };
}

export function assertPortableContentUrl(contentUrl: string) {
  if (contentUrl.startsWith("/") || contentUrl.includes("\\") || /[?#]/.test(contentUrl) || /^[a-z][a-z\d+.-]*:/i.test(contentUrl)) {
    throw new Error("Seeded files must use relative contentUrl values without a query or fragment.");
  }
  const segments = contentUrl.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Seeded files must use normalized relative contentUrl values.");
  }
}

export function parsePortableSeededManifest(value: unknown): PortableSeededManifest {
  return readSeeded(value, true);
}

export function parseBundledSeededManifest(value: unknown): BundledSeededManifest {
  return readSeeded(value, false) as unknown as BundledSeededManifest;
}

export function parseSeededManifest(value: unknown): SeededManifest {
  return parseBundledSeededManifest(value);
}

export function toPortableSeededManifest(
  desktop: { layout: DesktopLayout; editorSettings: EditorSettings; entries: DesktopEntry[] },
  contentUrlFor: (file: FileEntry) => string,
): PortableSeededManifest {
  return parsePortableSeededManifest({
    version: 4,
    layout: desktop.layout,
    editorSettings: desktop.editorSettings,
    entries: desktop.entries.map((entry) => entry.kind === "file" ? { ...entry, contentUrl: contentUrlFor(entry) } : entry),
  });
}
