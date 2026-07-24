import { describe, expect, test } from "bun:test";
import { isStandalone, pwaInstallState, type InstallPromptEvent } from "../src/lib/pwa-install";

describe("PWA installation state", () => {
  test("prioritizes standalone and installed status over prompt guidance", () => {
    const prompt = {} as InstallPromptEvent;
    expect(pwaInstallState(prompt, false, true)).toBe("standalone");
    expect(pwaInstallState(prompt, true, false)).toBe("installed");
    expect(pwaInstallState(prompt, false, false)).toBe("promptable");
    expect(pwaInstallState(null, false, false)).toBe("guidance");
    expect(isStandalone(true, false)).toBe(true);
    expect(isStandalone(false, true)).toBe(true);
  });
});
