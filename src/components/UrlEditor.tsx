import { ArrowSquareOut, LinkSimple, WarningCircle } from "@phosphor-icons/react";
import { parseInternetShortcut, readInternetShortcutUrl, updateInternetShortcutDraft } from "../lib/internet-shortcut";

type Props = {
  content: string;
  readOnly: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
};

export function UrlEditor({ content, readOnly, onChange, onSave }: Props) {
  let destination = "";
  let error = "";
  try {
    destination = readInternetShortcutUrl(content);
    parseInternetShortcut(content);
  } catch (parseError) {
    try {
      destination = readInternetShortcutUrl(content);
    } catch {
      destination = "";
    }
    error = parseError instanceof Error ? parseError.message : "Enter a valid URL.";
  }

  const shortcut = (() => {
    try { return parseInternetShortcut(content); } catch { return null; }
  })();

  function openShortcut() {
    if (!shortcut) return;
    window.open(shortcut.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="url-editor">
      <div className="url-editor__mark" aria-hidden="true"><LinkSimple size={34} weight="duotone" /></div>
      <div className="url-editor__copy">
        <span className="window-kicker">Internet shortcut</span>
        <h3>{readOnly ? "Shortcut destination" : "Where should this shortcut go?"}</h3>
        <p>{readOnly ? "Open the saved destination in a new tab." : <>Use a complete destination including its scheme, such as <code>https://</code> or <code>mailto:</code>.</>}</p>
      </div>
      <label className="url-editor__field">
        <span>Destination URL</span>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={readOnly}
          value={destination}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "url-editor-error" : undefined}
          placeholder="https://example.com"
          onChange={(event) => onChange(updateInternetShortcutDraft(content, event.target.value))}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !readOnly && shortcut) {
              event.preventDefault();
              onSave();
            }
          }}
        />
      </label>
      {error && <p className="url-editor__error" id="url-editor-error">{error}</p>}
      {shortcut?.sensitive && (
        <div className="url-editor__warning" role="alert">
          <WarningCircle size={19} weight="fill" />
          <span><strong>Potentially unsafe destination.</strong> The <code>{shortcut.scheme}:</code> scheme can execute content or access local resources. Open it only if you trust this shortcut.</span>
        </div>
      )}
      <div className="url-editor__actions">
        <button className={`button ${shortcut?.sensitive ? "button--danger" : "button--primary"}`} type="button" disabled={!shortcut} onClick={openShortcut}>
          <ArrowSquareOut size={17} /> {shortcut?.sensitive ? "Open anyway" : "Open link"}
        </button>
      </div>
    </div>
  );
}
