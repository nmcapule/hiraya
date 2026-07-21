export const API_ROUTES = {
  workspace: "/api/workspace",
  bootstrap: "/api/bootstrap",
  imports: "/api/imports",
  entries: "/api/entries",
  layout: "/api/layout",
  desktopPositions: "/api/desktop-positions",
  editorSettings: "/api/editor-settings",
  events: "/api/events",
  health: "/api/health",
  entry: (id: string) => `/api/entries/${encodeURIComponent(id)}`,
  content: (id: string) => `/api/files/${encodeURIComponent(id)}/content`,
} as const;
