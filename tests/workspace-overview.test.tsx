import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceOverview } from "../src/components/WorkspaceOverview";

const props = {
  areas: [{ segment: { column: 0, row: 0 }, rootItemCount: 0, windowCount: 0, current: true, occupied: false, key: "0:0", label: "Home", coordinateLabel: "Column 0, row 0" }],
  windows: [{ id: "window", title: "Notes", areaId: "0:0", areaLabel: "Home" }],
  canMutate: true,
  selectedRootCount: 0,
  arranging: false,
  onArrangeChange: () => undefined,
  onCreateAdjacent: () => undefined,
  onGo: () => undefined,
  onFocusWindow: () => undefined,
  onMoveSelected: () => undefined,
  onMoveFocusedWindow: () => undefined,
  onMoveContentsAndRemove: () => undefined,
  onArrange: () => undefined,
  onOpenHelp: () => undefined,
} as const;

describe("WorkspaceOverview tabs", () => {
  test("opens the requested initial tab with complete tab and panel relationships", () => {
    const markup = renderToStaticMarkup(<WorkspaceOverview {...props} initialView="windows" />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toMatch(/role="tab"[^>]+aria-selected="true"[^>]+aria-controls="[^"]+-windows-panel"/);
    expect(markup).toMatch(/id="[^"]+-windows-panel" role="tabpanel" aria-labelledby="[^"]+-windows-tab"/);
    expect(markup).toContain("0 occupied regions, 1 open window");
  });
});
