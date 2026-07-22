export type EntryPosition = { x: number; y: number };

export const WALLPAPERS = ["dusk", "grove", "ember"] as const;
export type Wallpaper = typeof WALLPAPERS[number];
export const DEFAULT_WALLPAPER: Wallpaper = "dusk";

export type DesktopLayout = {
  snapToGrid: boolean;
  wallpaper: Wallpaper;
};

export type DesktopPositionUpdate = {
  entryId: string;
  position: EntryPosition;
};

export type DesktopIdentity = {
  id: string;
  name: string;
};

export type EditorLanguage = "auto" | "plain" | "markdown" | "json" | "javascript" | "typescript" | "jsx" | "tsx" | "css" | "html" | "xml" | "yaml";

export type EditorSettings = {
  autoSave: boolean;
  autoFormat: boolean;
  fontSize: number;
  language: EditorLanguage;
  lineWrap: boolean;
};

type BaseEntry = {
  id: string;
  name: string;
  parentId: string | null;
  modifiedAt: number;
  position: EntryPosition;
};

export type FileEntry = BaseEntry & {
  kind: "file";
  mimeType: string;
  size: number;
};

export type FolderEntry = BaseEntry & {
  kind: "folder";
};

export type DesktopEntry = FileEntry | FolderEntry;

export type DialogState =
  | { type: "create-file"; parentId: string | null; position?: EntryPosition }
  | { type: "create-folder"; parentId: string | null; position?: EntryPosition }
  | { type: "rename"; entryId: string }
  | { type: "delete"; entryIds: string[] }
  | null;

export type ContextMenuState =
  | { type: "entry"; entryId: string; x: number; y: number }
  | { type: "desktop"; parentId: string | null; x: number; y: number; position: EntryPosition }
  | null;
