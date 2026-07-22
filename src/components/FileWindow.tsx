import { useCallback, useEffect, useRef, useState } from "react";
import { Check, DownloadSimple, FloppyDisk } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import type { EditorLanguage, EditorSettings, FileEntry } from "../types";
import { fileCapabilities } from "../ui/file-capabilities";
import { TextEditor } from "./TextEditor";
import { UrlEditor } from "./UrlEditor";
import { parseInternetShortcut } from "../lib/internet-shortcut";
import type { ThemeDefinition } from "../lib/themes";
import { ImagePreview } from "./ImagePreview";

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
  readOnly?: boolean;
  remoteChanged?: boolean;
  imageHeaderTarget?: HTMLDivElement | null;
  editorSettings: EditorSettings;
  theme: ThemeDefinition;
  onSave: (content: string) => Promise<void>;
  onDownload: () => void;
  onEditorSettingsChange: (settings: EditorSettings) => void;
  onResolveLink: (path: string) => Promise<{ file: FileEntry; blob: Blob }>;
  onOpenLinkedFile: (file: FileEntry) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function FileWindow({ file, blob, editable, readOnly = false, remoteChanged = false, imageHeaderTarget, editorSettings, theme, onSave, onDownload, onEditorSettingsChange, onResolveLink, onOpenLinkedFile, onDirtyChange }: Props) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentLoaded, setContentLoaded] = useState(false);
  const [objectUrl, setObjectUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [imageZoom, setImageZoom] = useState<ImageZoom>("fit");
  const savingRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const lastAutoSaveAttemptRef = useRef<string | null>(null);
  onSaveRef.current = onSave;

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
      await onSaveRef.current(nextContent);
      setSavedContent(nextContent);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Changes could not be saved.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  const dirty = content !== savedContent;
  const preview = fileCapabilities(file).preview;
  const validContent = preview !== "url" || (() => { try { parseInternetShortcut(content); return true; } catch { return false; } })();

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    setImageZoom("fit");
  }, [file.id]);

  useEffect(() => {
    if (!editable || readOnly || !editorSettings.autoSave || !contentLoaded || !dirty || !validContent || saving || lastAutoSaveAttemptRef.current === content) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveAttemptRef.current = content;
      void save(content);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [content, contentLoaded, dirty, editable, editorSettings.autoSave, readOnly, save, saving, validContent]);

  return (
    <div className="file-window file-window--embedded">
      {imageHeaderTarget && preview === "image" && createPortal(
        <div className="mobile-image-header" aria-label="Image preview settings">
          <ImageZoomControl value={imageZoom} onChange={setImageZoom} />
          <button className="icon-button mobile-image-header__download" type="button" onClick={onDownload} aria-label="Download file">
            <DownloadSimple size={17} />
          </button>
        </div>,
        imageHeaderTarget,
      )}
      {!(imageHeaderTarget && preview === "image") && (
        <div className="file-window__actions">
          <span className="file-window__mode">{preview === "url" ? readOnly ? "URL preview" : "URL editor" : editable ? readOnly ? "Text preview" : "Text editor" : "Preview"}{dirty ? " / Unsaved" : ""}</span>
          <div className="window-controls">
            <button className="icon-button icon-button--wide" type="button" onClick={onDownload} aria-label="Download file">
              <DownloadSimple size={17} /> <span>Download</span>
            </button>
            {editable && !readOnly && (
              <button className="button button--primary button--save" type="button" onClick={() => void save(content)} disabled={saving || !dirty || !validContent}>
                {saving ? <FloppyDisk size={17} /> : <Check size={17} />}
                {saving ? "Saving" : dirty ? "Save" : "Saved"}
              </button>
            )}
          </div>
        </div>
      )}
        {saveError && <div className="window-error">{saveError}</div>}
        {remoteChanged && <div className="window-error">This file changed on the server. Your unsaved text is preserved; saving it will become the latest version.</div>}
        {!editable && preview === "image" && !imageHeaderTarget && (
          <div className="editor-toolbar image-preview-toolbar" aria-label="Image preview settings">
            <ImageZoomControl value={imageZoom} onChange={setImageZoom} />
          </div>
        )}
        {editable && preview === "text" && !readOnly && (
          <div className="editor-toolbar" aria-label="Editor settings">
            <label>
              <span>Language</span>
              <select
                value={editorSettings.language}
                onChange={(event) => onEditorSettingsChange({ ...editorSettings, language: event.target.value as EditorSettings["language"] })}
              >
                {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="editor-toolbar__toggle">
              <input
                type="checkbox"
                checked={editorSettings.autoSave}
                onChange={(event) => {
                  lastAutoSaveAttemptRef.current = null;
                  onEditorSettingsChange({ ...editorSettings, autoSave: event.target.checked });
                }}
              />
              <span>Auto save</span>
            </label>
            <label>
              <span>Font size</span>
              <select
                value={editorSettings.fontSize}
                onChange={(event) => onEditorSettingsChange({ ...editorSettings, fontSize: Number(event.target.value) })}
              >
                {[11, 12, 13, 14, 15, 16, 18, 20, 22].map((size) => <option key={size} value={size}>{size}px</option>)}
              </select>
            </label>
          </div>
        )}
        <div className="file-window__content">
          {editable && preview === "text" && contentLoaded && (
            <TextEditor
              key={file.id}
              file={file}
              value={content}
              settings={editorSettings}
              theme={theme}
              readOnly={readOnly}
              onChange={setContent}
              onSave={() => void save(content)}
              onResolveLink={onResolveLink}
              onOpenLinkedFile={onOpenLinkedFile}
            />
          )}
          {preview === "url" && contentLoaded && (
            <UrlEditor content={content} readOnly={readOnly} onChange={setContent} onSave={() => void save(content)} />
          )}
          {!editable && preview === "image" && objectUrl && <ImagePreview src={objectUrl} alt={file.name} zoom={imageZoom} onZoomChange={setImageZoom} />}
          {!editable && preview === "pdf" && objectUrl && <iframe className="preview-frame" src={objectUrl} title={file.name} />}
          {!editable && preview === "video" && objectUrl && <video className="preview-media" src={objectUrl} controls />}
          {!editable && preview === "audio" && objectUrl && <audio className="preview-audio" src={objectUrl} controls />}
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
