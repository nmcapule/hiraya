import { useEffect, useRef } from "react";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { EditorLanguage, EditorSettings, FileEntry } from "../types";

type LinkedFile = { file: FileEntry; blob: Blob };

type Props = {
  file: FileEntry;
  value: string;
  settings: EditorSettings;
  onChange: (value: string) => void;
  onSave: () => void;
  onResolveLink: (path: string) => Promise<LinkedFile>;
  onOpenLinkedFile: (file: FileEntry) => void;
};

const EXTENSION_LANGUAGES: Record<string, EditorLanguage> = {
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

function resolvedLanguage(language: EditorLanguage, fileName: string) {
  if (language !== "auto") return language;
  return EXTENSION_LANGUAGES[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? "plain";
}

function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case "markdown": return markdown();
    case "json": return json();
    case "javascript": return javascript();
    case "typescript": return javascript({ typescript: true });
    case "jsx": return javascript({ jsx: true });
    case "tsx": return javascript({ jsx: true, typescript: true });
    case "css": return css();
    case "html": return html();
    case "xml": return xml();
    case "yaml": return yaml();
    default: return [];
  }
}

function markdownLinks(text: string) {
  const paths: string[] = [];
  const pattern = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const path = (match[1] ?? match[2]).replace(/\\([\\()])/g, "$1");
    if (!path || path.startsWith("#") || path.startsWith("/") || path.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) continue;
    paths.push(path);
  }
  return paths;
}

function isTextPreviewable(file: FileEntry) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.mimeType.startsWith("text/") || file.mimeType.includes("json") || TEXT_EXTENSIONS.has(extension);
}

function isPreviewable(file: FileEntry) {
  return isTextPreviewable(file) || file.mimeType.startsWith("image/") || file.mimeType === "application/pdf" || file.mimeType.startsWith("video/") || file.mimeType.startsWith("audio/");
}

class MediaPreviewWidget extends WidgetType {
  private destroyed = false;
  private urls: string[] = [];

  constructor(
    readonly paths: string[],
    readonly resolveLink: (path: string) => Promise<LinkedFile>,
    readonly openFile: (file: FileEntry) => void,
  ) {
    super();
  }

  eq(other: MediaPreviewWidget) {
    return this.paths.length === other.paths.length && this.paths.every((path, index) => path === other.paths[index]);
  }

  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "inline-media-row";
    row.setAttribute("aria-label", "Local file previews");

    for (const path of this.paths) {
      const preview = document.createElement("div");
      preview.className = "inline-media-preview inline-media-preview--loading";
      preview.setAttribute("role", "button");
      preview.setAttribute("tabindex", "0");
      preview.setAttribute("aria-label", `Open preview for ${path}`);
      preview.textContent = `Loading ${path}…`;
      preview.addEventListener("mousedown", (event) => event.preventDefault());
      row.append(preview);

      void this.resolveLink(path).then(async ({ file, blob }) => {
        if (this.destroyed) return;
        if (!isPreviewable(file)) {
          preview.hidden = true;
          view.requestMeasure();
          return;
        }

        preview.className = "inline-media-preview";
        preview.textContent = "";
        preview.setAttribute("aria-label", `Open ${file.name} in preview`);
        preview.addEventListener("click", () => this.openFile(file));
        preview.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          this.openFile(file);
        });

        const label = document.createElement("span");
        label.className = "inline-media-preview__label";
        label.textContent = file.name;
        preview.append(label);

        if (isTextPreviewable(file)) {
          const text = document.createElement("pre");
          text.className = "inline-media-preview__text";
          text.textContent = await blob.text();
          if (this.destroyed) return;
          preview.prepend(text);
        } else {
          const url = URL.createObjectURL(blob);
          this.urls.push(url);

          if (file.mimeType.startsWith("image/")) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = file.name;
            preview.prepend(image);
          } else if (file.mimeType === "application/pdf") {
            const frame = document.createElement("iframe");
            frame.src = url;
            frame.title = file.name;
            frame.tabIndex = -1;
            preview.prepend(frame);
          } else if (file.mimeType.startsWith("video/")) {
            const video = document.createElement("video");
            video.src = url;
            video.preload = "metadata";
            video.muted = true;
            preview.prepend(video);
          } else {
            const audio = document.createElement("audio");
            audio.src = url;
            audio.controls = true;
            audio.addEventListener("click", (event) => event.stopPropagation());
            preview.prepend(audio);
          }
        }
        view.requestMeasure();
      }).catch((error: unknown) => {
        if (this.destroyed) return;
        preview.className = "inline-media-preview inline-media-preview--error";
        preview.textContent = error instanceof Error ? error.message : `Could not load ${path}.`;
        view.requestMeasure();
      });
    }
    return row;
  }

  ignoreEvent() {
    return true;
  }

  destroy() {
    this.destroyed = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }
}

function inlinePreviews(
  resolveLink: (path: string) => Promise<LinkedFile>,
  openFile: (file: FileEntry) => void,
) {
  function buildDecorations(state: EditorState) {
    const widgets: Range<Decoration>[] = [];
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const paths = markdownLinks(line.text);
      if (paths.length) widgets.push(Decoration.widget({ widget: new MediaPreviewWidget(paths, resolveLink, openFile), block: true, side: 1 }).range(line.to));
    }
    return Decoration.set(widgets, true);
  }

  return StateField.define<DecorationSet>({
    create: buildDecorations,
    update: (decorations, transaction) => transaction.docChanged ? buildDecorations(transaction.state) : decorations,
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function TextEditor({ file, value, settings, onChange, onSave, onResolveLink, onOpenLinkedFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const languageConfig = useRef(new Compartment());
  const fontConfig = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const resolveLinkRef = useRef(onResolveLink);
  const openLinkedFileRef = useRef(onOpenLinkedFile);
  const initialConfig = useRef({ value, fileName: file.name, language: resolvedLanguage(settings.language, file.name), fontSize: settings.fontSize });
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  resolveLinkRef.current = onResolveLink;
  openLinkedFileRef.current = onOpenLinkedFile;

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      doc: initialConfig.current.value,
      extensions: [
        basicSetup,
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": `Contents of ${initialConfig.current.fileName}`, spellcheck: "true" }),
        languageConfig.current.of(languageExtension(initialConfig.current.language)),
        fontConfig.current.of(EditorView.theme({ "&": { fontSize: `${initialConfig.current.fontSize}px` } })),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        inlinePreviews(
          (path) => resolveLinkRef.current(path),
          (linkedFile) => openLinkedFileRef.current(linkedFile),
        ),
      ],
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageConfig.current.reconfigure(languageExtension(resolvedLanguage(settings.language, file.name))) });
  }, [file.name, settings.language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: fontConfig.current.reconfigure(EditorView.theme({ "&": { fontSize: `${settings.fontSize}px` } })) });
  }, [settings.fontSize]);

  return <div className="text-editor" ref={containerRef} aria-label={`Contents of ${file.name}`} />;
}
