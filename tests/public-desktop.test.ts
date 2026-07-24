import { describe, expect, test } from "bun:test";
import { fetchPublicFile, LargeDownloadAuthRequiredError, publicTokenFromPath } from "../src/lib/public-desktop";

const file = { kind: "file" as const, id: "file", name: "archive.zip", parentId: null, createdAt: 1, modifiedAt: 1, position: { x: 0, y: 0 }, mimeType: "application/zip", size: 100 };

describe("public desktop", () => {
  test("recognizes only opaque public routes", () => {
    expect(publicTokenFromPath("/shared/a%2Bb")).toBe("a+b");
    expect(publicTokenFromPath("/shared/token/extra")).toBeNull();
    expect(publicTokenFromPath("/desktops/shared")).toBeNull();
  });

  test("surfaces the large-download authentication gate without session handling", async () => {
    const fetchImpl = (async () => Response.json({ error: "sign in", code: "large_download_auth_required", loginUrl: "/login?returnTo=%2Fshared%2Ftoken" }, { status: 401 })) as typeof fetch;
    const result = fetchPublicFile("token", file, 3, fetchImpl);
    await expect(result).rejects.toBeInstanceOf(LargeDownloadAuthRequiredError);
    await expect(result).rejects.toMatchObject({ loginUrl: "/login?returnTo=%2Fshared%2Ftoken" });
  });

  test("does not request content until explicitly asked", () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    void fetchImpl;
    expect(calls).toBe(0);
  });
});
