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
import { markdownLinkTargets, markdownPreviewTargets, type EmbeddedPreviewTarget, type ExternalPreviewTarget } from "../lib/embedded-preview";
import { editorLanguageFor, fileCapabilities } from "../ui/file-capabilities";

type LinkedFile = { file: FileEntry; blob: Blob };

type Props = {
  file: FileEntry;
  value: string;
  settings: EditorSettings;
  theme: ThemeDefinition;
  externalEmbeddedPreviews: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
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

class MediaPreviewWidget extends WidgetType {
  private destroyed = false;
  private urls: string[] = [];

  constructor(
    readonly targets: EmbeddedPreviewTarget[],
    readonly resolveLink: (path: string) => Promise<LinkedFile>,
    readonly openFile: (file: FileEntry) => void,
  ) {
    super();
  }

  eq(other: MediaPreviewWidget) {
    return JSON.stringify(this.targets) === JSON.stringify(other.targets);
  }

  private externalPreview(target: ExternalPreviewTarget, view: EditorView) {
    const preview = document.createElement("div");
    preview.className = `inline-media-preview inline-media-preview--external inline-media-preview--${target.kind}`;

    const header = document.createElement("div");
    header.className = "inline-media-preview__header";
    const label = document.createElement("strong");
    label.textContent = target.label;
    const link = document.createElement("a");
    link.href = target.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.textContent = `Open ${target.host}`;
    link.addEventListener("mousedown", (event) => event.stopPropagation());
    header.append(label, link);
    preview.append(header);

    const fail = () => {
      preview.classList.add("inline-media-preview--error");
      const message = document.createElement("span");
      message.className = "inline-media-preview__message";
      message.textContent = `Could not load content from ${target.host}.`;
      preview.append(message);
      view.requestMeasure();
    };

    if (target.kind === "image") {
      const image = document.createElement("img");
      image.src = target.previewUrl;
      image.alt = target.label;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", fail, { once: true });
      preview.prepend(image);
    } else if (target.kind === "video") {
      const video = document.createElement("video");
      video.src = target.previewUrl;
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("referrerpolicy", "no-referrer");
      video.addEventListener("error", fail, { once: true });
      preview.prepend(video);
    } else if (target.kind === "audio") {
      const audio = document.createElement("audio");
      audio.src = target.previewUrl;
      audio.controls = true;
      audio.preload = "metadata";
      audio.setAttribute("referrerpolicy", "no-referrer");
      audio.addEventListener("error", fail, { once: true });
      preview.prepend(audio);
    } else {
      const frame = document.createElement("iframe");
      frame.src = target.previewUrl;
      frame.title = `${target.label} preview`;
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer";
      frame.allow = target.kind === "youtube" || target.kind === "vimeo" ? "accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen" : "fullscreen";
      frame.sandbox.add("allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-scripts");
      if (target.kind === "youtube" || target.kind === "vimeo") frame.sandbox.add("allow-same-origin", "allow-presentation");
      preview.prepend(frame);
      if (target.kind === "site") {
        const hint = document.createElement("span");
        hint.className = "inline-media-preview__hint";
        hint.textContent = "Some sites block embedded viewing. Open externally if this preview is blank.";
        preview.append(hint);
      }
    }
    return preview;
  }

  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "inline-media-row";
    row.setAttribute("aria-label", "Embedded previews");

    for (const target of this.targets) {
      if (target.kind !== "local") {
        row.append(this.externalPreview(target, view));
        continue;
      }
      const path = target.path;
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
  externalEnabled: boolean,
) {
  function buildDecorations(state: EditorState) {
    const widgets: Range<Decoration>[] = [];
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const targets = markdownPreviewTargets(line.text, externalEnabled);
      if (targets.length) widgets.push(Decoration.widget({ widget: new MediaPreviewWidget(targets, resolveLink, openFile), block: true, side: 1 }).range(line.to));
    }
    return Decoration.set(widgets, true);
  }

  return StateField.define<DecorationSet>({
    create: buildDecorations,
    update: (decorations, transaction) => transaction.docChanged ? buildDecorations(transaction.state) : decorations,
    provide: (field) => EditorView.decorations.from(field),
  });
}

function inlineMarkdownLinks(
  resolveLink: (path: string) => Promise<LinkedFile>,
  openFile: (file: FileEntry) => void,
): Extension {
  function buildDecorations(state: EditorState) {
    const decorations: Range<Decoration>[] = [];
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      for (const target of markdownLinkTargets(line.text)) {
        decorations.push(Decoration.mark({
          class: "cm-markdown-link",
          attributes: {
            "data-link-destination": target.destination,
            "data-link-kind": target.kind,
            role: "link",
            tabindex: "0",
            "aria-label": `Open ${target.label}`,
          },
        }).range(line.from + target.from, line.from + target.to));
      }
    }
    return Decoration.set(decorations, true);
  }

  const links = StateField.define<DecorationSet>({
    create: buildDecorations,
    update: (decorations, transaction) => transaction.docChanged ? buildDecorations(transaction.state) : decorations,
    provide: (field) => EditorView.decorations.from(field),
  });

  const activate = (element: HTMLElement) => {
    const destination = element.dataset.linkDestination;
    if (!destination) return;
    if (element.dataset.linkKind === "external") {
      window.open(destination, "_blank", "noopener,noreferrer");
      return;
    }
    void resolveLink(destination).then(({ file }) => openFile(file)).catch((error: unknown) => {
      element.title = error instanceof Error ? error.message : `Could not open ${destination}.`;
    });
  };

  return [
    links,
    EditorView.domEventHandlers({
      click(event) {
        if (event.button !== 0 || !(event.target instanceof Element)) return false;
        const element = event.target.closest<HTMLElement>(".cm-markdown-link");
        if (!element) return false;
        event.preventDefault();
        activate(element);
        return true;
      },
      keydown(event) {
        if ((event.key !== "Enter" && event.key !== " ") || !(event.target instanceof Element)) return false;
        const element = event.target.closest<HTMLElement>(".cm-markdown-link");
        if (!element) return false;
        event.preventDefault();
        activate(element);
        return true;
      },
    }),
  ];
}

export function TextEditor({ file, value, settings, theme, externalEmbeddedPreviews, readOnly = false, onChange, onSave, onResolveLink, onOpenLinkedFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const languageConfig = useRef(new Compartment());
  const fontConfig = useRef(new Compartment());
  const editableConfig = useRef(new Compartment());
  const lineWrapConfig = useRef(new Compartment());
  const themeConfig = useRef(new Compartment());
  const previewConfig = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const resolveLinkRef = useRef(onResolveLink);
  const openLinkedFileRef = useRef(onOpenLinkedFile);
  const initialConfig = useRef({ value, fileName: file.name, language: editorLanguageFor(file.name, settings.language), fontSize: settings.fontSize, lineWrap: settings.lineWrap, theme, externalEmbeddedPreviews, readOnly });
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
        lineWrapConfig.current.of(initialConfig.current.lineWrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({ "aria-label": `Contents of ${initialConfig.current.fileName}`, spellcheck: "true" }),
        languageConfig.current.of(languageExtension(initialConfig.current.language)),
        fontConfig.current.of(EditorView.theme({ "&": { fontSize: `${initialConfig.current.fontSize}px` } })),
        editableConfig.current.of(EditorView.editable.of(!initialConfig.current.readOnly)),
        themeConfig.current.of(editorTheme(initialConfig.current.theme)),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: (target) => { onSaveRef.current(target.state.doc.toString()); return true; } }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        previewConfig.current.of(inlinePreviews(
          (path) => resolveLinkRef.current(path),
          (linkedFile) => openLinkedFileRef.current(linkedFile),
          initialConfig.current.externalEmbeddedPreviews,
        )),
        inlineMarkdownLinks(
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
    viewRef.current?.dispatch({ effects: lineWrapConfig.current.reconfigure(settings.lineWrap ? EditorView.lineWrapping : []) });
  }, [settings.lineWrap]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableConfig.current.reconfigure(EditorView.editable.of(!readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeConfig.current.reconfigure(editorTheme(theme)) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: previewConfig.current.reconfigure(inlinePreviews(
      (path) => resolveLinkRef.current(path),
      (linkedFile) => openLinkedFileRef.current(linkedFile),
      externalEmbeddedPreviews,
    )) });
  }, [externalEmbeddedPreviews]);

  return <div className="text-editor" ref={containerRef} aria-label={`Contents of ${file.name}`} />;
}
