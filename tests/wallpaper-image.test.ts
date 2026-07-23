import { describe, expect, test } from "bun:test";
import { validateWallpaperImage } from "../src/lib/wallpaper-image";

const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("wallpaper image validation", () => {
  test("checks MIME, signature, decoded dimensions, and pixel limits", async () => {
    const valid = new File([pngSignature], "wallpaper.png", { type: "image/png" });
    expect(await validateWallpaperImage(valid, async () => ({ width: 4000, height: 3000 }))).toEqual({ width: 4000, height: 3000 });
    expect(await validateWallpaperImage(new File([pngSignature], "wallpaper.png", { type: "image/png; variant=seeded" }), async () => ({ width: 1, height: 1 }))).toEqual({ width: 1, height: 1 });
    await expect(validateWallpaperImage(new File([pngSignature], "fake.jpg", { type: "image/jpeg" }), async () => ({ width: 1, height: 1 }))).rejects.toThrow("do not match");
    await expect(validateWallpaperImage(valid, async () => { throw new Error("decode"); })).rejects.toThrow("decoded");
    await expect(validateWallpaperImage(valid, async () => ({ width: 8192, height: 8192 }))).rejects.toThrow("40 megapixels");
  });
});
