export type OverlayState = {
  dialog: boolean;
  moveDialog: boolean;
  settings: boolean;
  contextMenu: boolean;
  file: boolean;
  explorer: boolean;
  viewEditor: boolean;
};

export type OverlayOwner = keyof OverlayState;

const OVERLAY_PRIORITY: readonly OverlayOwner[] = ["contextMenu", "moveDialog", "dialog", "file", "settings", "explorer", "viewEditor"];

export function topOverlay(state: OverlayState): OverlayOwner | null {
  return OVERLAY_PRIORITY.find((overlay) => state[overlay]) ?? null;
}
