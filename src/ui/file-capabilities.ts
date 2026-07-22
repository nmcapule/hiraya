import type { EditorLanguage, FileEntry } from "../types";

export type FilePreviewKind = "text" | "markdown" | "url" | "image" | "pdf" | "video" | "audio" | "none";
export type FileIconKind = "code" | "text" | "url" | "image" | "pdf" | "video" | "audio" | "archive" | "file";

const EXTENSION_LANGUAGES: Readonly<Record<string, EditorLanguage>> = {
  css: "css",
  htm: "html",
  html: "html",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "js", "jsx", "ts", "tsx", "css", "html", "xml", "csv", "yaml", "yml"]);
const CODE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "css", "html", "json", "md"]);

export function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function editorLanguageFor(fileName: string, language: EditorLanguage) {
  return language === "auto" ? EXTENSION_LANGUAGES[fileExtension(fileName)] ?? "plain" : language;
}

export function fileCapabilities(file: FileEntry) {
  const extension = fileExtension(file.name);
  const mimeType = file.mimeType.toLowerCase();
  const urlShortcut = extension === "url";
  const markdown = extension === "md" || extension === "markdown" || mimeType.split(";", 1)[0].trim() === "text/markdown";
  const editable = urlShortcut || mimeType.startsWith("text/") || mimeType.includes("json") || TEXT_EXTENSIONS.has(extension);
  const preview: FilePreviewKind = urlShortcut ? "url"
    : markdown ? "markdown"
    : editable ? "text"
    : mimeType.startsWith("image/") ? "image"
      : mimeType === "application/pdf" ? "pdf"
        : mimeType.startsWith("video/") ? "video"
          : mimeType.startsWith("audio/") ? "audio"
            : "none";
  const icon: FileIconKind = urlShortcut ? "url"
    : mimeType.startsWith("image/") ? "image"
    : mimeType.startsWith("video/") ? "video"
      : mimeType.startsWith("audio/") ? "audio"
        : mimeType === "application/pdf" ? "pdf"
          : mimeType.includes("zip") || mimeType.includes("compressed") ? "archive"
            : CODE_EXTENSIONS.has(extension) ? "code"
              : editable ? "text"
                : "file";

  return { editable, preview, icon } as const;
}
