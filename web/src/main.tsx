import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, LanguageSupport } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { go } from '@codemirror/lang-go';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Braces,
  Check,
  ChevronLeft,
  FilePlus2,
  FolderPlus,
  Menu,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  Redo2,
  Save,
  Search as SearchIcon,
  Terminal,
  Trash2,
  Undo2,
  X
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Entry = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
};

type FileKind = 'text' | 'image' | 'pdf' | 'unsupported';
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'preview' | 'error';
type Mode = 'editor' | 'terminal';
type ReplaceScope = 'file' | 'folder';
type InputChangeEvent = { target: HTMLInputElement };
type EditorOptions = {
  lineWrap: boolean;
  fontSize: number;
  darkMode: boolean;
  lineNumbers: boolean;
};

type ReplaceRequest = {
  path: string;
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  previewOnly: boolean;
};

type ReplaceMatch = {
  path: string;
  count: number;
};

type ReplaceResponse = {
  path: string;
  filesScanned: number;
  filesMatched: number;
  replacements: number;
  matches: ReplaceMatch[];
};

const defaultEditorOptions: EditorOptions = {
  lineWrap: true,
  fontSize: 14,
  darkMode: false,
  lineNumbers: true
};

const editorOptionsKey = 'hiraya.editorOptions';

function clampFontSize(size: number): number {
  return Math.min(22, Math.max(12, size));
}

function readEditorOptions(): EditorOptions {
  try {
    const raw = window.localStorage.getItem(editorOptionsKey);
    if (!raw) return defaultEditorOptions;
    const parsed = JSON.parse(raw) as Partial<EditorOptions>;
    return {
      lineWrap: typeof parsed.lineWrap === 'boolean' ? parsed.lineWrap : defaultEditorOptions.lineWrap,
      fontSize: typeof parsed.fontSize === 'number' ? clampFontSize(parsed.fontSize) : defaultEditorOptions.fontSize,
      darkMode: typeof parsed.darkMode === 'boolean' ? parsed.darkMode : defaultEditorOptions.darkMode,
      lineNumbers: typeof parsed.lineNumbers === 'boolean' ? parsed.lineNumbers : defaultEditorOptions.lineNumbers
    };
  } catch {
    return defaultEditorOptions;
  }
}

function writeEditorOptions(options: EditorOptions) {
  try {
    window.localStorage.setItem(editorOptionsKey, JSON.stringify(options));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

function syncAppViewportHeight() {
  document.documentElement.style.setProperty('--app-viewport-height', `${viewportHeight()}px`);
}

function onAppViewportChange(callback?: () => void): () => void {
  let frame = 0;
  const update = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncAppViewportHeight();
      callback?.();
    });
  };
  const visualViewport = window.visualViewport;

  syncAppViewportHeight();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  visualViewport?.addEventListener('resize', update);
  visualViewport?.addEventListener('scroll', update);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
  };
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {})
    }
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function parentPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

function joinPath(base: string, name: string): string {
  const cleanName = name.trim().replace(/^\/+/, '');
  if (!cleanName) return base;
  return base === '/' ? `/${cleanName}` : `${base}/${cleanName}`;
}

function basename(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.at(-1) ?? '/';
}

function previewKindFor(path: string): FileKind | null {
  const ext = path.toLowerCase().split('.').at(-1);
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'ico':
      return 'image';
    case 'pdf':
      return 'pdf';
    default:
      return null;
  }
}

function rawFileURL(path: string): string {
  return `/api/raw?path=${encodeURIComponent(path)}`;
}

function languageFor(path: string): LanguageSupport | null {
  const ext = path.toLowerCase().split('.').at(-1);
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return javascript({ jsx: ext === 'jsx' || ext === 'tsx', typescript: ext === 'ts' || ext === 'tsx' });
    case 'json':
      return json();
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'md':
    case 'markdown':
      return markdown();
    case 'go':
      return go();
    case 'py':
      return python();
    case 'rs':
      return rust();
    case 'sql':
      return sql();
    case 'xml':
    case 'svg':
      return xml();
    default:
      return null;
  }
}

function isWordChar(value: string | undefined): boolean {
  return !!value && /[\p{L}\p{N}_]/u.test(value);
}

function isWholeWordMatch(text: string, from: number, to: number): boolean {
  return !isWordChar(text[from - 1]) && !isWordChar(text[to]);
}

function findLiteralMatch(
  text: string,
  query: string,
  start: number,
  direction: 'next' | 'previous',
  caseSensitive: boolean,
  wholeWord: boolean
): { from: number; to: number } | null {
  if (!query) return null;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const step = direction === 'next' ? needle.length : -1;
  let index = direction === 'next' ? haystack.indexOf(needle, start) : haystack.lastIndexOf(needle, Math.max(0, start));

  while (index >= 0) {
    const to = index + query.length;
    if (!wholeWord || isWholeWordMatch(text, index, to)) return { from: index, to };
    index = direction === 'next' ? haystack.indexOf(needle, index + step) : haystack.lastIndexOf(needle, index - 1);
  }

  const wrappedStart = direction === 'next' ? 0 : text.length;
  index = direction === 'next' ? haystack.indexOf(needle, wrappedStart) : haystack.lastIndexOf(needle, wrappedStart);
  while (index >= 0) {
    const to = index + query.length;
    if (!wholeWord || isWholeWordMatch(text, index, to)) return { from: index, to };
    index = direction === 'next' ? haystack.indexOf(needle, index + step) : haystack.lastIndexOf(needle, index - 1);
  }

  return null;
}

function countLiteralMatches(text: string, query: string, caseSensitive: boolean, wholeWord: boolean): number {
  if (!query) return 0;
  let count = 0;
  let start = 0;
  while (start <= text.length) {
    const match = findLiteralMatch(text, query, start, 'next', caseSensitive, wholeWord);
    if (!match || match.from < start) break;
    count++;
    start = match.to;
  }
  return count;
}

function replaceAllLiteralMatches(text: string, query: string, replacement: string, caseSensitive: boolean, wholeWord: boolean) {
  if (!query) return { text, count: 0 };
  let next = '';
  let start = 0;
  let count = 0;
  while (start <= text.length) {
    const match = findLiteralMatch(text, query, start, 'next', caseSensitive, wholeWord);
    if (!match || match.from < start) break;
    next += text.slice(start, match.from) + replacement;
    start = match.to;
    count++;
  }
  if (count === 0) return { text, count: 0 };
  return { text: next + text.slice(start), count };
}

function App() {
  const [mode, setMode] = useState<Mode>('editor');
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentDir, setCurrentDir] = useState('/');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [currentFileKind, setCurrentFileKind] = useState<FileKind>('text');
  const [content, setContent] = useState('');
  const [documentVersion, setDocumentVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [editorOptions, setEditorOptions] = useState<EditorOptions>(readEditorOptions());
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const editorMenuRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  const title = currentFile ? basename(currentFile) : 'No file open';
  const isEditable = mode === 'editor' && currentFileKind === 'text';
  const handleEditorReady = useCallback((view: EditorView | null) => {
    editorRef.current = view;
    setEditorView(view);
  }, []);

  useEffect(() => onAppViewportChange(), []);

  useEffect(() => writeEditorOptions(editorOptions), [editorOptions]);

  useEffect(() => {
    if (!editorMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!editorMenuRef.current?.contains(event.target as Node)) setEditorMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsideClick);
    return () => window.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [editorMenuOpen]);

  const loadTree = useCallback(async (path: string) => {
    const data = await api<{ path: string; entries: Entry[] }>(`/api/tree?path=${encodeURIComponent(path)}`);
    setCurrentDir(data.path);
    setEntries(data.entries);
  }, []);

  useEffect(() => {
    loadTree('/').catch((err) => setError(err.message));
  }, [loadTree]);

  useEffect(() => {
    if (mode === 'terminal') setTerminalStarted(true);
    setEditorMenuOpen(false);
    if (mode === 'terminal') setSearchPanelOpen(false);
  }, [mode]);

  useEffect(() => {
    setEditorMenuOpen(false);
    setSearchPanelOpen(false);
  }, [currentFile]);

  const openFile = useCallback(async (path: string) => {
    setError(null);
    const previewKind = previewKindFor(path);
    if (previewKind) {
      setCurrentFile(path);
      setCurrentFileKind(previewKind);
      setContent('');
      setDocumentVersion((version) => version + 1);
      setSaveState('preview');
      setDrawerOpen(false);
      setMode('editor');
      return;
    }
    try {
      const data = await api<{ content: string; path: string }>(`/api/file?path=${encodeURIComponent(path)}`);
      setCurrentFile(data.path);
      setCurrentFileKind('text');
      setContent(data.content);
      setDocumentVersion((version) => version + 1);
      setSaveState('saved');
      setDrawerOpen(false);
      setMode('editor');
    } catch (err) {
      if (err instanceof Error && err.message === 'file does not appear to be text') {
        setCurrentFile(path);
        setCurrentFileKind('unsupported');
        setContent('');
        setDocumentVersion((version) => version + 1);
        setSaveState('preview');
        setDrawerOpen(false);
        setMode('editor');
        return;
      }
      throw err;
    }
  }, []);

  const saveFile = useCallback(async () => {
    if (!currentFile || currentFileKind !== 'text' || !editorRef.current) return;
    setSaveState('saving');
    setError(null);
    try {
      const next = editorRef.current.state.doc.toString();
      await api(`/api/file?path=${encodeURIComponent(currentFile)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: next })
      });
      setContent(next);
      setSaveState('saved');
      await loadTree(parentPath(currentFile));
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentFile, currentFileKind, loadTree]);

  const createPath = useCallback(
    async (kind: 'file' | 'dir') => {
      const label = kind === 'file' ? 'New file path' : 'New folder path';
      const name = window.prompt(label, currentDir === '/' ? '' : `${currentDir}/`);
      if (!name) return;
      const path = name.startsWith('/') ? name : joinPath(currentDir, name);
      try {
        if (kind === 'file') {
          await api('/api/file', { method: 'POST', body: JSON.stringify({ path, content: '' }) });
          await loadTree(parentPath(path));
          await openFile(path);
        } else {
          await api('/api/dir', { method: 'POST', body: JSON.stringify({ path }) });
          await loadTree(parentPath(path));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [currentDir, loadTree, openFile]
  );

  const renamePath = useCallback(
    async (entry: Entry) => {
      const next = window.prompt('Rename path', entry.path);
      if (!next || next === entry.path) return;
      try {
        await api('/api/path', { method: 'PATCH', body: JSON.stringify({ from: entry.path, to: next }) });
        if (currentFile === entry.path) setCurrentFile(next);
        await loadTree(currentDir);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [currentDir, currentFile, loadTree]
  );

  const deletePath = useCallback(
    async (entry: Entry) => {
      if (!window.confirm(`Delete ${entry.path}?`)) return;
      try {
        await api(`/api/path?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
        if (currentFile === entry.path) {
          setCurrentFile(null);
          setCurrentFileKind('text');
          setContent('');
          setDocumentVersion((version) => version + 1);
          setSaveState('idle');
        }
        await loadTree(currentDir);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [currentDir, currentFile, loadTree]
  );

  const replaceInFolder = useCallback(
    async (request: ReplaceRequest) => {
      if (!request.previewOnly && saveState === 'dirty') {
        throw new Error('Save the open file before replacing across a folder.');
      }
      const result = await api<ReplaceResponse>('/api/replace', {
        method: 'POST',
        body: JSON.stringify(request)
      });
      if (!request.previewOnly) {
        await loadTree(currentDir);
        if (currentFile && result.matches.some((match) => match.path === currentFile)) {
          await openFile(currentFile);
        }
      }
      return result;
    },
    [currentDir, currentFile, loadTree, openFile, saveState]
  );

  return (
    <div className={`app ${editorOptions.darkMode ? 'dark' : ''}`}>
      <header className="topbar">
        <div className="left-actions">
          <button className="icon-button" onClick={() => setDrawerOpen(true)} title="Files">
            <Menu size={21} />
          </button>
          <button
            className={`mode-button ${mode === 'terminal' ? 'active' : ''}`}
            onClick={() => setMode(mode === 'editor' ? 'terminal' : 'editor')}
            title={mode === 'editor' ? 'Open terminal' : 'Open editor'}
          >
            {mode === 'editor' ? <Terminal size={20} /> : <Braces size={20} />}
          </button>
        </div>
        <div className="title-block">
          <div className="file-title">{mode === 'terminal' ? 'Terminal' : title}</div>
          <div className={`save-state ${saveState}`}>{mode === 'editor' ? saveStateLabel(saveState) : 'host shell'}</div>
        </div>
        <div className="right-actions">
          <button className="icon-button" onClick={() => editorRef.current && undo(editorRef.current)} disabled={!isEditable} title="Undo">
            <Undo2 size={19} />
          </button>
          <button className="icon-button" onClick={() => editorRef.current && redo(editorRef.current)} disabled={!isEditable} title="Redo">
            <Redo2 size={19} />
          </button>
          <button
            className={`icon-button ${searchPanelOpen ? 'active' : ''}`}
            onClick={() => setSearchPanelOpen((open) => !open)}
            disabled={!isEditable || !currentFile}
            title="Find and replace"
          >
            <SearchIcon size={19} />
          </button>
          <button className="icon-button primary" onClick={saveFile} disabled={!currentFile || !isEditable} title="Save">
            <Save size={19} />
          </button>
          <div className="editor-menu-wrap" ref={editorMenuRef}>
            <button
              className={`icon-button ${editorMenuOpen ? 'active' : ''}`}
              onClick={() => setEditorMenuOpen((open) => !open)}
              title="Editor options"
              aria-haspopup="menu"
              aria-expanded={editorMenuOpen}
            >
              <MoreVertical size={19} />
            </button>
            {editorMenuOpen && (
              <EditorOptionsMenu
                options={editorOptions}
                onChange={(next) => setEditorOptions(next)}
              />
            )}
          </div>
        </div>
      </header>

      {searchPanelOpen && isEditable && currentFile && (
        <SearchReplacePanel
          editor={editorView}
          currentDir={currentDir}
          currentFile={currentFile}
          onClose={() => setSearchPanelOpen(false)}
          onFolderReplace={replaceInFolder}
        />
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="Dismiss">
            <X size={18} />
          </button>
        </div>
      )}

      <main className="workspace">
        <div className={`workspace-panel ${mode === 'editor' ? 'active' : ''}`} aria-hidden={mode !== 'editor'} inert={mode !== 'editor'}>
          <FileSurface
            path={currentFile}
            kind={currentFileKind}
            content={content}
            version={documentVersion}
            editorOptions={editorOptions}
            onReady={handleEditorReady}
            onChange={(next) => {
              setContent(next);
              setSaveState('dirty');
            }}
          />
        </div>
        {terminalStarted && (
          <div className={`workspace-panel ${mode === 'terminal' ? 'active' : ''}`} aria-hidden={mode !== 'terminal'} inert={mode !== 'terminal'}>
            <TerminalView active={mode === 'terminal'} />
          </div>
        )}
      </main>

      {isEditable && currentFile && <AccessoryBar editor={editorView} />}

      <aside className={`drawer ${drawerOpen ? 'open' : ''}`} aria-hidden={!drawerOpen} inert={!drawerOpen}>
        <div className="drawer-header">
          <button className="icon-button" onClick={() => setDrawerOpen(false)} title="Close files">
            <ChevronLeft size={21} />
          </button>
          <div>
            <div className="drawer-title">Files</div>
            <div className="drawer-path">{currentDir}</div>
          </div>
          <div className="drawer-actions">
            <button className="icon-button" onClick={() => createPath('file')} title="New file">
              <FilePlus2 size={18} />
            </button>
            <button className="icon-button" onClick={() => createPath('dir')} title="New folder">
              <FolderPlus size={18} />
            </button>
          </div>
        </div>
        <div className="file-list">
          {currentDir !== '/' && (
            <button className="file-row parent" onClick={() => loadTree(parentPath(currentDir)).catch((err) => setError(err.message))}>
              ..
            </button>
          )}
          {entries.map((entry) => (
            <div className="file-row-wrap" key={entry.path}>
              <button
                className={`file-row ${entry.type}`}
                onClick={() => {
                  if (entry.type === 'dir') loadTree(entry.path).catch((err) => setError(err.message));
                  else openFile(entry.path).catch((err) => setError(err.message));
                }}
              >
                <span>{entry.type === 'dir' ? '/' : ''}</span>
                <strong>{entry.name}</strong>
              </button>
              <button className="mini-button" onClick={() => renamePath(entry)} title="Rename">
                <Pencil size={16} />
              </button>
              <button className="mini-button danger" onClick={() => deletePath(entry)} title="Delete">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </aside>
      {drawerOpen && <button className="scrim" onClick={() => setDrawerOpen(false)} aria-label="Close file drawer" />}
    </div>
  );
}

function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'dirty':
      return 'unsaved';
    case 'saving':
      return 'saving';
    case 'saved':
      return 'saved';
    case 'preview':
      return 'preview';
    case 'error':
      return 'save failed';
    default:
      return 'ready';
  }
}

function FileSurface({
  path,
  kind,
  content,
  version,
  editorOptions,
  onReady,
  onChange
}: {
  path: string | null;
  kind: FileKind;
  content: string;
  version: number;
  editorOptions: EditorOptions;
  onReady: (view: EditorView | null) => void;
  onChange: (content: string) => void;
}) {
  if (!path || kind === 'text') {
    return <CodeEditor path={path} content={content} version={version} editorOptions={editorOptions} onReady={onReady} onChange={onChange} />;
  }

  if (kind === 'image') {
    return (
      <div className="preview-host">
        <img className="image-preview" src={rawFileURL(path)} alt={basename(path)} />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <div className="preview-host">
        <iframe className="pdf-preview" src={rawFileURL(path)} title={basename(path)} />
      </div>
    );
  }

  return (
    <div className="empty-state">
      <X size={28} />
      <p>This file cannot be previewed or edited.</p>
    </div>
  );
}

function SearchReplacePanel({
  editor,
  currentDir,
  currentFile,
  onClose,
  onFolderReplace
}: {
  editor: EditorView | null;
  currentDir: string;
  currentFile: string;
  onClose: () => void;
  onFolderReplace: (request: ReplaceRequest) => Promise<ReplaceResponse>;
}) {
  const [scope, setScope] = useState<ReplaceScope>('file');
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [folderPreview, setFolderPreview] = useState<ReplaceResponse | null>(null);

  const fileMatchCount = useMemo(() => {
    if (!editor || !query) return 0;
    return countLiteralMatches(editor.state.doc.toString(), query, caseSensitive, wholeWord);
  }, [editor, query, caseSensitive, wholeWord]);

  useEffect(() => {
    setFolderPreview(null);
    setStatus(query ? `${fileMatchCount} in file` : 'Ready');
  }, [query, replacement, caseSensitive, wholeWord, scope, fileMatchCount]);

  const selectMatch = (direction: 'next' | 'previous') => {
    if (!editor || !query) return;
    const selection = editor.state.selection.main;
    const text = editor.state.doc.toString();
    const start = direction === 'next' ? selection.to : selection.from - 1;
    const match = findLiteralMatch(text, query, start, direction, caseSensitive, wholeWord);
    if (!match) {
      setStatus('No matches');
      editor.focus();
      return;
    }
    editor.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true
    });
    editor.focus();
    setStatus(`${fileMatchCount} in file`);
  };

  const replaceCurrent = () => {
    if (!editor || !query) return;
    const selection = editor.state.selection.main;
    const selected = editor.state.doc.sliceString(selection.from, selection.to);
    const matchesSelection =
      selected.length === query.length &&
      (caseSensitive ? selected === query : selected.toLowerCase() === query.toLowerCase()) &&
      (!wholeWord || isWholeWordMatch(editor.state.doc.toString(), selection.from, selection.to));

    if (!matchesSelection) {
      selectMatch('next');
      return;
    }

    editor.dispatch({
      changes: { from: selection.from, to: selection.to, insert: replacement },
      selection: { anchor: selection.from + replacement.length },
      scrollIntoView: true
    });
    editor.focus();
    setStatus('Replaced 1 match');
  };

  const replaceAllInFile = () => {
    if (!editor || !query) return;
    const text = editor.state.doc.toString();
    const result = replaceAllLiteralMatches(text, query, replacement, caseSensitive, wholeWord);
    if (result.count === 0) {
      setStatus('No matches');
      return;
    }
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.text },
      selection: { anchor: 0 },
      scrollIntoView: true
    });
    editor.focus();
    setStatus(`Replaced ${result.count} in file`);
  };

  const previewFolder = async () => {
    if (!query) return;
    setStatus('Scanning folder');
    const result = await onFolderReplace({
      path: currentDir,
      search: query,
      replace: replacement,
      caseSensitive,
      wholeWord,
      previewOnly: true
    });
    setFolderPreview(result);
    setStatus(`${result.replacements} matches in ${result.filesMatched} files`);
  };

  const replaceFolder = async () => {
    if (!query) return;
    const preview =
      folderPreview ??
      (await onFolderReplace({
        path: currentDir,
        search: query,
        replace: replacement,
        caseSensitive,
        wholeWord,
        previewOnly: true
      }));
    setFolderPreview(preview);
    if (preview.replacements === 0) {
      setStatus('No folder matches');
      return;
    }
    if (!window.confirm(`Replace ${preview.replacements} matches in ${preview.filesMatched} files under ${currentDir}?`)) {
      setStatus('Folder replace canceled');
      return;
    }
    setStatus('Replacing folder matches');
    const result = await onFolderReplace({
      path: currentDir,
      search: query,
      replace: replacement,
      caseSensitive,
      wholeWord,
      previewOnly: false
    });
    setFolderPreview(result);
    setStatus(`Replaced ${result.replacements} in ${result.filesMatched} files`);
  };

  const runFolderAction = (action: () => Promise<void>) => {
    action().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
  };

  return (
    <section className="search-panel" aria-label="Find and replace">
      <div className="search-panel-header">
        <div className="scope-tabs" role="tablist" aria-label="Find scope">
          <button className={scope === 'file' ? 'active' : ''} onClick={() => setScope('file')} role="tab" aria-selected={scope === 'file'}>
            File
          </button>
          <button className={scope === 'folder' ? 'active' : ''} onClick={() => setScope('folder')} role="tab" aria-selected={scope === 'folder'}>
            Folder
          </button>
        </div>
        <div className="search-context">{scope === 'file' ? basename(currentFile) : currentDir}</div>
        <button className="mini-button" onClick={onClose} title="Close find and replace">
          <X size={16} />
        </button>
      </div>
      <div className="search-grid">
        <label>
          <span>Find</span>
          <input value={query} onChange={(event: InputChangeEvent) => setQuery(event.target.value)} autoFocus />
        </label>
        <label>
          <span>Replace</span>
          <input value={replacement} onChange={(event: InputChangeEvent) => setReplacement(event.target.value)} />
        </label>
      </div>
      <div className="search-options">
        <label>
          <input type="checkbox" checked={caseSensitive} onChange={(event: InputChangeEvent) => setCaseSensitive(event.target.checked)} />
          <span>Match case</span>
        </label>
        <label>
          <input type="checkbox" checked={wholeWord} onChange={(event: InputChangeEvent) => setWholeWord(event.target.checked)} />
          <span>Whole word</span>
        </label>
      </div>
      {scope === 'file' ? (
        <div className="search-actions">
          <button onClick={() => selectMatch('previous')} disabled={!editor || !query}>
            Previous
          </button>
          <button onClick={() => selectMatch('next')} disabled={!editor || !query}>
            Next
          </button>
          <button onClick={replaceCurrent} disabled={!editor || !query}>
            Replace
          </button>
          <button onClick={replaceAllInFile} disabled={!editor || !query}>
            Replace all
          </button>
        </div>
      ) : (
        <div className="search-actions">
          <button onClick={() => runFolderAction(previewFolder)} disabled={!query}>
            Preview
          </button>
          <button className="danger-action" onClick={() => runFolderAction(replaceFolder)} disabled={!query}>
            Replace folder
          </button>
        </div>
      )}
      <div className="search-status">{status}</div>
      {scope === 'folder' && folderPreview && folderPreview.matches.length > 0 && (
        <div className="search-results">
          {folderPreview.matches.slice(0, 5).map((match) => (
            <div key={match.path}>
              <span>{match.path}</span>
              <strong>{match.count}</strong>
            </div>
          ))}
          {folderPreview.matches.length > 5 && <div>{folderPreview.matches.length - 5} more files</div>}
        </div>
      )}
    </section>
  );
}

function CodeEditor({
  path,
  content,
  version,
  editorOptions,
  onReady,
  onChange
}: {
  path: string | null;
  content: string;
  version: number;
  editorOptions: EditorOptions;
  onReady: (view: EditorView | null) => void;
  onChange: (content: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(() => {
    const lang = path ? languageFor(path) : null;
    const palette = editorOptions.darkMode
      ? {
          background: '#181812',
          foreground: '#eee9dc',
          gutter: '#202018',
          border: '#3a372f',
          active: '#2a291f',
          selection: '#3c4f43',
          cursor: '#f4c95d'
        }
      : {
          background: '#f7f7f4',
          foreground: '#26251f',
          gutter: '#f7f7f4',
          border: '#dedbd2',
          active: '#eceae2',
          selection: '#c9ddd3',
          cursor: '#185b45'
        };
    return [
      history(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ...(editorOptions.lineNumbers ? [lineNumbers()] : []),
      ...(editorOptions.lineWrap ? [EditorView.lineWrapping] : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: palette.background, color: palette.foreground, fontSize: `${editorOptions.fontSize}px` },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
        '.cm-content': { padding: '18px 0', minHeight: '100%' },
        '.cm-line': { padding: '0 18px' },
        '.cm-gutters': { backgroundColor: palette.gutter, borderRight: `1px solid ${palette.border}`, color: palette.foreground },
        '.cm-activeLine': { backgroundColor: palette.active },
        '.cm-activeLineGutter': { backgroundColor: palette.active },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.cursor },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: palette.selection }
      }),
      ...(lang ? [lang] : [])
    ];
  }, [path, editorOptions]);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: hostRef.current
    });
    onReady(view);
    return () => {
      onReady(null);
      view.destroy();
    };
  }, [extensions, onReady, version]);

  if (!path) {
    return (
      <div className="empty-state">
        <Check size={28} />
        <p>Open a file from the drawer.</p>
      </div>
    );
  }

  return <div className="editor-host" ref={hostRef} />;
}

function EditorOptionsMenu({
  options,
  onChange
}: {
  options: EditorOptions;
  onChange: (options: EditorOptions) => void;
}) {
  const setOption = (next: Partial<EditorOptions>) => onChange({ ...options, ...next });
  const setFontSize = (fontSize: number) => setOption({ fontSize: clampFontSize(fontSize) });

  return (
    <div className="editor-menu" role="menu">
      <label className="editor-menu-row">
        <span>Line wrap</span>
        <input type="checkbox" checked={options.lineWrap} onChange={(event: InputChangeEvent) => setOption({ lineWrap: event.target.checked })} />
      </label>
      <div className="editor-menu-row">
        <span>Text size</span>
        <div className="size-stepper" aria-label="Text size">
          <button onClick={() => setFontSize(options.fontSize - 1)} disabled={options.fontSize <= 12} title="Decrease text size">
            <Minus size={15} />
          </button>
          <output>{options.fontSize}px</output>
          <button onClick={() => setFontSize(options.fontSize + 1)} disabled={options.fontSize >= 22} title="Increase text size">
            <Plus size={15} />
          </button>
        </div>
      </div>
      <label className="editor-menu-row">
        <span>Dark mode</span>
        <input type="checkbox" checked={options.darkMode} onChange={(event: InputChangeEvent) => setOption({ darkMode: event.target.checked })} />
      </label>
      <label className="editor-menu-row">
        <span>Line numbers</span>
        <input type="checkbox" checked={options.lineNumbers} onChange={(event: InputChangeEvent) => setOption({ lineNumbers: event.target.checked })} />
      </label>
    </div>
  );
}

function AccessoryBar({ editor }: { editor: EditorView | null }) {
  const send = (text: string) => {
    if (!editor) return;
    editor.dispatch(editor.state.replaceSelection(text));
    editor.focus();
  };
  return (
    <div className="accessory-bar">
      {['{', '}', '[', ']', '(', ')', '/', '=', '"', "'"].map((key) => (
        <button key={key} onClick={() => send(key)}>
          {key}
        </button>
      ))}
      <button onClick={() => send('  ')}>Tab</button>
      <button onClick={() => editor?.focus()}>Esc</button>
    </div>
  );
}

function TerminalView({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#171713',
        foreground: '#f6f2e8',
        cursor: '#f5c542'
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    const fitTerminal = () => {
      if (disposed || !hostRef.current) return;
      const bounds = hostRef.current.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1) return;
      try {
        fit.fit();
      } catch {
        // xterm can briefly report missing dimensions while mounting or disposing.
      }
    };
    fitRef.current = fitTerminal;
    requestAnimationFrame(fitTerminal);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}/api/terminal`);
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      fitTerminal();
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') term.write(msg.data);
      if (msg.type === 'error') term.writeln(`\r\n${msg.data}`);
    });
    term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    const resize = () => {
      fitTerminal();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const stopViewportResize = onAppViewportChange(resize);
    return () => {
      disposed = true;
      fitRef.current = null;
      stopViewportResize();
      socket.close();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.();
      const socket = socketRef.current;
      const term = termRef.current;
      if (socket?.readyState === WebSocket.OPEN && term) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
      term?.focus();
    });
  }, [active]);

  const send = (data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    termRef.current?.focus();
  };

  return (
    <div className="terminal-pane">
      <div className="terminal-host" ref={hostRef} />
      <div className="terminal-keys">
        <button onClick={() => send('\u0003')}>Ctrl-C</button>
        <button onClick={() => send('\u001b')}>Esc</button>
        <button onClick={() => send('\t')}>Tab</button>
      </div>
    </div>
  );
}

syncAppViewportHeight();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
