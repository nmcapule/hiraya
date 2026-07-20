export type EntryPosition = { x: number; y: number };

export type DesktopView = { id: string };

export type DesktopLayout = {
  views: DesktopView[];
  columns: number;
  snapToGrid: boolean;
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
  | { type: "rename"; entry: DesktopEntry }
  | { type: "delete"; entry: DesktopEntry }
  | null;

export type ContextMenuState = {
  entry: DesktopEntry;
  x: number;
  y: number;
} | null;
