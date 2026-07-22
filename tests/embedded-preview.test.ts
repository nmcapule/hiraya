import { describe, expect, test } from "bun:test";
import { markdownLinkTargets, markdownPreviewTargets } from "../src/lib/embedded-preview";

describe("embedded previews", () => {
  test("keeps local embeds available when external previews are disabled", () => {
    expect(markdownPreviewTargets("![Local](../images/photo.png) [Site](https://example.com)", false)).toEqual([
      { kind: "local", path: "../images/photo.png", label: "Local" },
    ]);
  });

  test("only classifies embed syntax as external previews", () => {
    expect(markdownPreviewTargets("![Sunset](https://cdn.example/photo.jpg?id=2) ![Example](https://example.com/path) [Not embedded](https://cdn.example/logo.webp)", true)).toEqual([
      {
        kind: "image",
        sourceUrl: "https://cdn.example/photo.jpg?id=2",
        previewUrl: "https://cdn.example/photo.jpg?id=2",
        label: "Sunset",
        host: "cdn.example",
      },
      {
        kind: "site",
        sourceUrl: "https://example.com/path",
        previewUrl: "https://example.com/path",
        label: "Example",
        host: "example.com",
      },
    ]);
  });

  test("normalizes YouTube and Vimeo URLs", () => {
    const inputs = [
      "![Watch](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
      "![Short](https://youtu.be/dQw4w9WgXcQ?t=3)",
      "![Vertical](https://youtube.com/shorts/dQw4w9WgXcQ)",
      "![Live](https://youtube.com/live/dQw4w9WgXcQ)",
      "![Vimeo](https://vimeo.com/76979871)",
    ].join(" ");
    expect(markdownPreviewTargets(inputs, true).map((target) => target.kind === "local" ? "" : target.previewUrl)).toEqual([
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://player.vimeo.com/video/76979871",
    ]);
  });

  test("classifies direct media from URL paths", () => {
    expect(markdownPreviewTargets("![Movie](https://media.example/movie.webm?download=1) ![Song](https://media.example/song.mp3)", true).map((target) => target.kind)).toEqual(["video", "audio"]);
  });

  test("rejects executable, local, and credential-bearing external URLs", () => {
    const text = "![Script](javascript:alert(1)) ![Data](data:text/html,test) ![File](file:///tmp/a) ![Credentials](https://user:pass@example.com/)";
    expect(markdownPreviewTargets(text, true)).toEqual([]);
  });

  test("supports angle-bracket destinations and Markdown titles", () => {
    expect(markdownPreviewTargets('![Site](<https://example.com/image path> "title")', true)).toMatchObject([
      { kind: "site", sourceUrl: "https://example.com/image%20path" },
    ]);
  });

  test("extracts clickable ordinary links without treating embeds as links", () => {
    const text = "Read [Example](<https://example.com/a path>) and [local notes](notes.md), not ![an embed](image.png).";
    expect(markdownLinkTargets(text)).toEqual([
      { kind: "external", destination: "https://example.com/a%20path", label: "Example", from: 6, to: 13 },
      { kind: "local", destination: "notes.md", label: "local notes", from: 50, to: 61 },
    ]);
  });

  test("does not activate unsafe Markdown links", () => {
    expect(markdownLinkTargets("[Script](javascript:alert(1)) [Credentials](https://user:pass@example.com) [Root](/admin)")).toEqual([]);
  });
});
