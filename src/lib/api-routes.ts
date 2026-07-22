const desktopBase = (desktopId: string) => `/api/desktops/${encodeURIComponent(desktopId)}`;
const scoped = (desktopId: string, path: string, legacy: string) => desktopId === "legacy" ? legacy : `${desktopBase(desktopId)}${path}`;

export const API_ROUTES = {
  desktops: "/api/desktops",
  desktop: (desktopId: string) => desktopBase(desktopId),
  desktopWorkspace: (desktopId: string) => desktopId === "legacy" ? "/api/workspace" : desktopBase(desktopId),
  desktopBootstrap: (desktopId: string) => scoped(desktopId, "/bootstrap", "/api/bootstrap"),
  desktopImports: (desktopId: string) => scoped(desktopId, "/imports", "/api/imports"),
  desktopEntries: (desktopId: string) => scoped(desktopId, "/entries", "/api/entries"),
  desktopBatchMoveEntries: (desktopId: string) => scoped(desktopId, "/entries/batch-move", "/api/entries/batch-move"),
  desktopBatchDeleteEntries: (desktopId: string) => scoped(desktopId, "/entries/batch-delete", "/api/entries/batch-delete"),
  desktopLayout: (desktopId: string) => scoped(desktopId, "/layout", "/api/layout"),
  desktopPositionsFor: (desktopId: string) => scoped(desktopId, "/positions", "/api/desktop-positions"),
  desktopEditorSettings: (desktopId: string) => scoped(desktopId, "/editor-settings", "/api/editor-settings"),
  desktopThemeSelection: (desktopId: string) => scoped(desktopId, "/theme-selection", "/api/theme-selection"),
  desktopEntry: (desktopId: string, id: string) => scoped(desktopId, `/entries/${encodeURIComponent(id)}`, `/api/entries/${encodeURIComponent(id)}`),
  desktopContent: (desktopId: string, id: string) => scoped(desktopId, `/files/${encodeURIComponent(id)}/content`, `/api/files/${encodeURIComponent(id)}/content`),
  desktopTheme: (desktopId: string, id: string) => scoped(desktopId, `/themes/${encodeURIComponent(id)}`, `/api/themes/${encodeURIComponent(id)}`),
  desktopMoves: "/api/desktop-moves",
  workspace: "/api/workspace",
  bootstrap: "/api/bootstrap",
  imports: "/api/imports",
  entries: "/api/entries",
  batchMoveEntries: "/api/entries/batch-move",
  batchDeleteEntries: "/api/entries/batch-delete",
  layout: "/api/layout",
  desktopPositions: "/api/desktop-positions",
  editorSettings: "/api/editor-settings",
  themeSelection: "/api/theme-selection",
  events: "/api/events",
  health: "/api/health",
  activity: (query: { q?: string; before?: number; limit: number }) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.before !== undefined) params.set("before", String(query.before));
    params.set("limit", String(query.limit));
    return `/api/activity?${params}`;
  },
  entry: (id: string) => `/api/entries/${encodeURIComponent(id)}`,
  content: (id: string) => `/api/files/${encodeURIComponent(id)}/content`,
  theme: (id: string) => `/api/themes/${encodeURIComponent(id)}`,
} as const;
