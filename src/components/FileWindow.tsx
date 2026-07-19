import { useEffect, useState } from "react";
import { Check, DownloadSimple, FloppyDisk, X } from "@phosphor-icons/react";
import type { EditorLanguage, EditorSettings, FileEntry } from "../types";
import { TextEditor } from "./TextEditor";

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

type Props = {
  file: FileEntry;
  blob: File;
  editable: boolean;
  editorSettings: EditorSettings;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
  onDownload: () => void;
  onEditorSettingsChange: (settings: EditorSettings) => void;
  onResolveLink: (path: string) => Promise<{ file: FileEntry; blob: Blob }>;
  onOpenLinkedFile: (file: FileEntry) => void;
};

export function FileWindow({ file, blob, editable, editorSettings, onClose, onSave, onDownload, onEditorSettingsChange, onResolveLink, onOpenLinkedFile }: Props) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentLoaded, setContentLoaded] = useState(false);
  const [objectUrl, setObjectUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      await onSave(content);
      setSavedContent(content);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Changes could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== savedContent;
  const isImage = file.mimeType.startsWith("image/");
  const isPdf = file.mimeType === "application/pdf";
  const isVideo = file.mimeType.startsWith("video/");
  const isAudio = file.mimeType.startsWith("audio/");

  return (
    <div className="modal-backdrop modal-backdrop--window" role="presentation">
      <section className="file-window" role="dialog" aria-modal="true" aria-labelledby="file-window-title">
        <header className="window-header file-window__header">
          <div className="file-window__title">
            <span className="window-kicker">{editable ? "Text editor" : "Preview"}</span>
            <h2 id="file-window-title">{file.name}{dirty ? " •" : ""}</h2>
          </div>
          <div className="window-controls">
            <button className="icon-button icon-button--wide" type="button" onClick={onDownload} aria-label="Download file">
              <DownloadSimple size={17} /> <span>Download</span>
            </button>
            {editable && (
              <button className="button button--primary button--save" type="button" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? <FloppyDisk size={17} /> : <Check size={17} />}
                {saving ? "Saving" : dirty ? "Save" : "Saved"}
              </button>
            )}
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close file">
              <X size={18} />
            </button>
          </div>
        </header>
        {saveError && <div className="window-error">{saveError}</div>}
        {editable && (
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
          {editable && contentLoaded && (
            <TextEditor
              key={file.id}
              file={file}
              value={content}
              settings={editorSettings}
              onChange={setContent}
              onSave={() => void save()}
              onResolveLink={onResolveLink}
              onOpenLinkedFile={onOpenLinkedFile}
            />
          )}
          {!editable && isImage && objectUrl && <img className="preview-image" src={objectUrl} alt={file.name} />}
          {!editable && isPdf && objectUrl && <iframe className="preview-frame" src={objectUrl} title={file.name} />}
          {!editable && isVideo && objectUrl && <video className="preview-media" src={objectUrl} controls />}
          {!editable && isAudio && objectUrl && <audio className="preview-audio" src={objectUrl} controls />}
          {!editable && !isImage && !isPdf && !isVideo && !isAudio && (
            <div className="no-preview">
              <p>No preview is available for this file type.</p>
              <button className="button button--primary" type="button" onClick={onDownload}>Download file</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
