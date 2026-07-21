import { useEffect, useRef } from "react";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import type { EditorLanguage, EditorSettings, FileEntry } from "../types";
import type { ThemeDefinition } from "../lib/themes";
import { editorLanguageFor, fileCapabilities } from "../ui/file-capabilities";

type LinkedFile = { file: FileEntry; blob: Blob };

type Props = {
  file: FileEntry;
  value: string;
  settings: EditorSettings;
  theme: ThemeDefinition;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onResolveLink: (path: string) => Promise<LinkedFile>;
  onOpenLinkedFile: (file: FileEntry) => void;
};

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

function editorTheme(theme: ThemeDefinition): Extension {
  const { colors } = theme;
  return [
    EditorView.theme({
      "&": { color: colors.editorText, backgroundColor: colors.editorBackground },
      ".cm-content": { caretColor: colors.accent },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: colors.accent },
      ".cm-gutters": { color: colors.textMuted, backgroundColor: colors.editorGutter, borderColor: colors.border },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: `${colors.selection}1f` },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: `${colors.selection}45` },
    }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: colors.editorKeyword },
      { tag: [tags.string, tags.special(tags.string)], color: colors.editorString },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: colors.editorComment, fontStyle: "italic" },
      { tag: [tags.number, tags.bool, tags.null], color: colors.accent },
      { tag: [tags.heading, tags.strong], color: colors.editorKeyword, fontWeight: "700" },
      { tag: [tags.link, tags.url], color: colors.accent, textDecoration: "underline" },
    ])),
  ];
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
        const { preview: previewKind } = fileCapabilities(file);
        if (previewKind === "none") {
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

        if (previewKind === "text") {
          const text = document.createElement("pre");
          text.className = "inline-media-preview__text";
          text.textContent = await blob.text();
          if (this.destroyed) return;
          preview.prepend(text);
        } else {
          const url = URL.createObjectURL(blob);
          this.urls.push(url);

          if (previewKind === "image") {
            const image = document.createElement("img");
            image.src = url;
            image.alt = file.name;
            preview.prepend(image);
          } else if (previewKind === "pdf") {
            const frame = document.createElement("iframe");
            frame.src = url;
            frame.title = file.name;
            frame.tabIndex = -1;
            preview.prepend(frame);
          } else if (previewKind === "video") {
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

export function TextEditor({ file, value, settings, theme, readOnly = false, onChange, onSave, onResolveLink, onOpenLinkedFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const languageConfig = useRef(new Compartment());
  const fontConfig = useRef(new Compartment());
  const editableConfig = useRef(new Compartment());
  const themeConfig = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const resolveLinkRef = useRef(onResolveLink);
  const openLinkedFileRef = useRef(onOpenLinkedFile);
  const initialConfig = useRef({ value, fileName: file.name, language: editorLanguageFor(file.name, settings.language), fontSize: settings.fontSize, theme, readOnly });
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
        editableConfig.current.of(EditorView.editable.of(!initialConfig.current.readOnly)),
        themeConfig.current.of(editorTheme(initialConfig.current.theme)),
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
    viewRef.current?.dispatch({ effects: languageConfig.current.reconfigure(languageExtension(editorLanguageFor(file.name, settings.language))) });
  }, [file.name, settings.language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: fontConfig.current.reconfigure(EditorView.theme({ "&": { fontSize: `${settings.fontSize}px` } })) });
  }, [settings.fontSize]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableConfig.current.reconfigure(EditorView.editable.of(!readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeConfig.current.reconfigure(editorTheme(theme)) });
  }, [theme]);

  return <div className="text-editor" ref={containerRef} aria-label={`Contents of ${file.name}`} />;
}
