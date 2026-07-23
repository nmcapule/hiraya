const desktopBase = (desktopId: string) => `/api/desktops/${encodeURIComponent(desktopId)}`;

export const API_ROUTES = {
  authSession: "/api/auth/session",
  catalog: "/api/catalog",
  desktops: "/api/desktops",
  desktop: (desktopId: string) => desktopBase(desktopId),
  desktopImports: (desktopId: string) => `${desktopBase(desktopId)}/imports`,
  desktopEntries: (desktopId: string) => `${desktopBase(desktopId)}/entries`,
  desktopMoveEntries: (desktopId: string) => `${desktopBase(desktopId)}/entries/move`,
  desktopDeleteEntries: (desktopId: string) => `${desktopBase(desktopId)}/entries/delete`,
  desktopLayout: (desktopId: string) => `${desktopBase(desktopId)}/layout`,
  desktopRootEntryPositions: (desktopId: string) => `${desktopBase(desktopId)}/root-entry-positions`,
  desktopEditorSettings: (desktopId: string) => `${desktopBase(desktopId)}/editor-settings`,
  desktopThemeSelection: (desktopId: string) => `${desktopBase(desktopId)}/theme-selection`,
  desktopEntry: (desktopId: string, id: string) => `${desktopBase(desktopId)}/entries/${encodeURIComponent(id)}`,
  desktopContent: (desktopId: string, id: string) => `${desktopBase(desktopId)}/entries/${encodeURIComponent(id)}/content`,
  desktopBlobMutations: (desktopId: string) => `${desktopBase(desktopId)}/blob-mutations`,
  desktopBlobMutation: (desktopId: string, uploadId: string) => `${desktopBase(desktopId)}/blob-mutations/${encodeURIComponent(uploadId)}`,
  desktopBlobMutationCommit: (desktopId: string, uploadId: string) => `${desktopBase(desktopId)}/blob-mutations/${encodeURIComponent(uploadId)}/commit`,
  desktopContentAccess: (desktopId: string, id: string, revision: number) => `${desktopBase(desktopId)}/entries/${encodeURIComponent(id)}/content-access?revision=${encodeURIComponent(String(revision))}`,
  desktopTheme: (desktopId: string, id: string) => `${desktopBase(desktopId)}/themes/${encodeURIComponent(id)}`,
  entryTransfers: "/api/entry-transfers",
  events: "/api/events",
  health: "/api/health",
  syncHealth: "/api/sync/health",
  activity: (query: { q?: string; before?: number; limit: number }) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.before !== undefined) params.set("before", String(query.before));
    params.set("limit", String(query.limit));
    return `/api/activity?${params}`;
  },
} as const;

export const SERVER_ROUTES = {
  login: "/login",
  profile: "/profile",
  logout: "/logout",
} as const;
