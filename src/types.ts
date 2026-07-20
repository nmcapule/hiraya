export type EntryPosition = { x: number; y: number };

export type DesktopView = { id: string };

export const WALLPAPERS = ["dusk", "grove", "ember"] as const;
export type Wallpaper = typeof WALLPAPERS[number];
export const DEFAULT_WALLPAPER: Wallpaper = "dusk";

export type DesktopLayout = {
  views: DesktopView[];
  columns: number;
  snapToGrid: boolean;
  wallpaper: Wallpaper;
};

export type EditorLanguage = "auto" | "plain" | "markdown" | "json" | "javascript" | "typescript" | "jsx" | "tsx" | "css" | "html" | "xml" | "yaml";

export type EditorSettings = {
  autoSave: boolean;
  fontSize: number;
  language: EditorLanguage;
};

type BaseEntry = {
  id: string;
  name: string;
  parentId: string | null;
  modifiedAt: number;
  position: EntryPosition;
  viewId: string | null;
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
  | { type: "create-file"; parentId: string | null }
  | { type: "create-folder"; parentId: string | null }
  | { type: "rename"; entryId: string }
  | { type: "delete"; entryId: string }
  | null;

export type ContextMenuState = {
  entryId: string;
  x: number;
  y: number;
} | null;
