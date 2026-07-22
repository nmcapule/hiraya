export const API_ROUTES = {
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
