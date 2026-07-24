import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppWindow } from "../src/components/AppWindow";

const base = {
  id: "window",
  title: "Document",
  titleId: "window-title",
  bounds: { x: 0, y: 0, width: 400, height: 300 },
  zIndex: 1,
  focused: true,
  minimized: false,
  segmentActive: true,
  mobile: true,
  onFocus: () => undefined,
  onBoundsChange: () => undefined,
  children: <div>Content</div>,
};

describe("AppWindow mobile actions", () => {
  test("renders mobile actions only when their callbacks exist", () => {
    const none = renderToStaticMarkup(<AppWindow {...base} />);
    expect(none).not.toContain("Back to Desktop");
    expect(none).not.toContain("Switch Window");
    expect(none).not.toContain(">Close<");

    const backOnly = renderToStaticMarkup(<AppWindow {...base} onShowDesktop={() => undefined} />);
    expect(backOnly).toContain("Back to Desktop");
    expect(backOnly).not.toContain("Switch Window");
    expect(backOnly).not.toContain(">Close<");
  });

  test("allows the global mobile shell to suppress duplicate window chrome", () => {
    const markup = renderToStaticMarkup(<AppWindow {...base} hideMobileHeader onShowDesktop={() => undefined} onSwitchWindow={() => undefined} onClose={() => undefined} />);
    expect(markup).not.toContain("app-window__header");
    expect(markup).toContain("Content");
  });
});
