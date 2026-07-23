import { useCallback, useEffect, useRef, useState } from "react";
import { Check, DownloadSimple, FloppyDisk, PencilSimple, SlidersHorizontal } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import type { EditorLanguage, EditorSettings, FileEntry } from "../types";
import { editorLanguageFor, fileCapabilities } from "../ui/file-capabilities";
import { TextEditor } from "./TextEditor";
import type { ThemeDefinition } from "../lib/themes";
import { ImagePreview } from "./ImagePreview";
import { MobileHeaderMenu } from "./MobileHeaderMenu";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { formatEditorText } from "../lib/format-text";

const LANGUAGE_OPTIONS: Array<{ value: EditorLanguage; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "plain", label: "Plain text" },
  { value: "markdown", label: "Markdown" },
  { value: "json", label: "JSON" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "jsx", label: "JSX" },
  { value: "tsx", label: "TSX" },
  { value: "css", label: "CSS" },
  { value: "html", label: "HTML" },
  { value: "xml", label: "XML" },
  { value: "yaml", label: "YAML" },
];

const IMAGE_ZOOM_OPTIONS = [25, 50, 75, 100, 125, 150, 200];

type ImageZoom = "fit" | number;

type ImageZoomControlProps = {
  value: ImageZoom;
  onChange: (zoom: ImageZoom) => void;
};

function ImageZoomControl({ value, onChange }: ImageZoomControlProps) {
  return (
    <label className="image-zoom-control">
      <span>Zoom</span>
      <select
        value={value}
        aria-label="Image zoom"
        onChange={(event) => onChange(event.target.value === "fit" ? "fit" : Number(event.target.value))}
      >
        <option value="fit">Fit</option>
        {typeof value === "number" && !IMAGE_ZOOM_OPTIONS.includes(Math.round(value * 100)) && (
          <option value={value}>{Math.round(value * 100)}%</option>
        )}
        {IMAGE_ZOOM_OPTIONS.map((percent) => <option key={percent} value={percent / 100}>{percent}%</option>)}
      </select>
    </label>
  );
}

type Props = {
  file: FileEntry;
  blob: File;
  editable: boolean;
  editMode?: boolean;
  readOnly?: boolean;
  remoteChanged?: boolean;
  headerActionsTarget?: HTMLDivElement | null;
  editorSettings: EditorSettings;
  externalEmbeddedPreviews: boolean;
  theme: ThemeDefinition;
  onSave: (content: string) => Promise<void>;
  onDownload: () => void;
  onEdit: () => void;
  onEditorSettingsChange: (settings: EditorSettings) => void;
  onResolveLink: (path: string) => Promise<{ file: FileEntry; blob: Blob }>;
  onOpenLinkedFile: (file: FileEntry) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function FileWindow({ file, blob, editable, editMode = false, readOnly = false, remoteChanged = false, headerActionsTarget, editorSettings, externalEmbeddedPreviews, theme, onSave, onDownload, onEdit, onEditorSettingsChange, onResolveLink, onOpenLinkedFile, onDirtyChange }: Props) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentLoaded, setContentLoaded] = useState(false);
  const [objectUrl, setObjectUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [imageZoom, setImageZoom] = useState<ImageZoom>("fit");
  const savingRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const editorSettingsRef = useRef(editorSettings);
  const lastAutoSaveAttemptRef = useRef<string | null>(null);
  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  editorSettingsRef.current = editorSettings;

  useEffect(() => {
    if (editable) {
      let active = true;
      setContentLoaded(false);
      void blob.text().then((text) => {
        if (!active) return;
        setContent(text);
        setSavedContent(text);
        setContentLoaded(true);
      });
      return () => { active = false; };
    }

    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob, editable]);

  const save = useCallback(async (nextContent: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const settings = editorSettingsRef.current;
      const saved = settings.autoFormat
        ? await formatEditorText(nextContent, editorLanguageFor(file.name, settings.language))
        : nextContent;
      if (saved !== nextContent) setContent(saved);
      await onSaveRef.current(saved);
      setSavedContent(saved);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Changes could not be saved.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [file.name]);

  const dirty = content !== savedContent;
  const preview = fileCapabilities(file).preview;
  const textEditor = editable && (editMode || preview === "text" || preview === "url");

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  useEffect(() => {
    setImageZoom("fit");
  }, [file.id]);

  useEffect(() => {
    if (!textEditor || readOnly || !editorSettings.autoSave || !contentLoaded || !dirty || saving || lastAutoSaveAttemptRef.current === content) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveAttemptRef.current = content;
      void save(content);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [content, contentLoaded, dirty, editorSettings.autoSave, readOnly, save, saving, textEditor]);

  return (
    <div className="file-window file-window--embedded">
      {headerActionsTarget && createPortal(
        <div className="file-header-actions" aria-label="File actions">
          {preview === "image" && <ImageZoomControl value={imageZoom} onChange={setImageZoom} />}
          {preview === "markdown" && !editMode && !readOnly && (
            <button className="button button--quiet file-header-actions__edit" type="button" onClick={onEdit}><PencilSimple size={16} /> Edit</button>
          )}
          {textEditor && !readOnly && (
            <MobileHeaderMenu label="Editor settings" icon={<SlidersHorizontal size={18} />}>
              {(dismiss) => <>
                <label>
                  <span>Language</span>
                  <select value={editorSettings.language} onChange={(event) => onEditorSettingsChange({ ...editorSettings, language: event.target.value as EditorSettings["language"] })}>
                    {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>Font size</span>
                  <select value={editorSettings.fontSize} onChange={(event) => onEditorSettingsChange({ ...editorSettings, fontSize: Number(event.target.value) })}>
                    {[11, 12, 13, 14, 15, 16, 18, 20, 22].map((size) => <option key={size} value={size}>{size}px</option>)}
                  </select>
                </label>
                <label className="mobile-header-menu__toggle">
                  <input type="checkbox" checked={editorSettings.autoSave} onChange={(event) => {
                    lastAutoSaveAttemptRef.current = null;
                    onEditorSettingsChange({ ...editorSettings, autoSave: event.target.checked });
                  }} />
                  <span>Autosave</span>
                </label>
                <label className="mobile-header-menu__toggle">
                  <input type="checkbox" checked={editorSettings.lineWrap} onChange={(event) => onEditorSettingsChange({ ...editorSettings, lineWrap: event.target.checked })} />
                  <span>Line wrap</span>
                </label>
                <label className="mobile-header-menu__toggle">
                  <input type="checkbox" checked={editorSettings.autoFormat} onChange={(event) => onEditorSettingsChange({ ...editorSettings, autoFormat: event.target.checked })} />
                  <span>Format on save</span>
                </label>
                <button type="button" onClick={() => { dismiss(); onDownload(); }}><DownloadSimple size={17} /> Download</button>
              </>}
            </MobileHeaderMenu>
          )}
          {(!textEditor || readOnly) && preview !== "none" && (
            <button className="icon-button file-header-actions__download" type="button" onClick={onDownload} aria-label="Download file">
              <DownloadSimple size={17} />
            </button>
          )}
          {textEditor && !readOnly && (
            <button className="button button--primary button--save file-header-actions__save" type="button" onClick={() => void save(content)} disabled={saving || !dirty}>
              {saving ? <FloppyDisk size={17} /> : <Check size={17} />}
              {saving ? "Saving" : dirty ? "Save" : "Saved"}
            </button>
          )}
        </div>,
        headerActionsTarget,
      )}
        {saveError && <div className="window-error" role="alert">{saveError}</div>}
        {remoteChanged && <div className="window-error" role="alert">This file changed on the server. Your unsaved text is preserved; saving it will become the latest version.</div>}
        <div className="file-window__content">
          {textEditor && contentLoaded && (
            <TextEditor
              key={file.id}
              file={file}
              value={content}
              settings={editorSettings}
              externalEmbeddedPreviews={externalEmbeddedPreviews}
              theme={theme}
              readOnly={readOnly}
              onChange={setContent}
              onSave={(nextContent) => void save(nextContent)}
              onResolveLink={onResolveLink}
              onOpenLinkedFile={onOpenLinkedFile}
            />
          )}
          {!editMode && preview === "markdown" && contentLoaded && (
            <MarkdownRenderer content={content} externalEmbeddedPreviews={externalEmbeddedPreviews} onResolveLink={onResolveLink} onOpenLinkedFile={onOpenLinkedFile} />
          )}
          {!editable && preview === "image" && objectUrl && <ImagePreview src={objectUrl} alt={file.name} zoom={imageZoom} onZoomChange={setImageZoom} />}
          {!editable && preview === "pdf" && objectUrl && <iframe className="preview-frame" src={objectUrl} title={file.name} />}
          {!editable && preview === "video" && objectUrl && <video className="preview-media" src={objectUrl} controls aria-label={`Video: ${file.name}`} />}
          {!editable && preview === "audio" && objectUrl && <audio className="preview-audio" src={objectUrl} controls aria-label={`Audio: ${file.name}`} />}
          {!editable && preview === "none" && (
            <div className="no-preview">
              <p>No preview is available for this file type.</p>
              <button className="button button--primary" type="button" onClick={onDownload}>Download file</button>
            </div>
          )}
        </div>
    </div>
  );
}
