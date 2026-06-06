import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, LanguageSupport } from '@codemirror/language';
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
  Pencil,
  Redo2,
  Save,
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

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
type Mode = 'editor' | 'terminal';

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

function App() {
  const [mode, setMode] = useState<Mode>('editor');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentDir, setCurrentDir] = useState('/');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [documentVersion, setDocumentVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  const title = currentFile ? basename(currentFile) : 'No file open';
  const handleEditorReady = useCallback((view: EditorView | null) => {
    editorRef.current = view;
    setEditorView(view);
  }, []);

  useEffect(() => onAppViewportChange(), []);

  const loadTree = useCallback(async (path: string) => {
    const data = await api<{ path: string; entries: Entry[] }>(`/api/tree?path=${encodeURIComponent(path)}`);
    setCurrentDir(data.path);
    setEntries(data.entries);
  }, []);

  useEffect(() => {
    loadTree('/').catch((err) => setError(err.message));
  }, [loadTree]);

  const openFile = useCallback(async (path: string) => {
    setError(null);
    const data = await api<{ content: string; path: string }>(`/api/file?path=${encodeURIComponent(path)}`);
    setCurrentFile(data.path);
    setContent(data.content);
    setDocumentVersion((version) => version + 1);
    setSaveState('saved');
    setDrawerOpen(false);
    setMode('editor');
  }, []);

  const saveFile = useCallback(async () => {
    if (!currentFile || !editorRef.current) return;
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
  }, [currentFile, loadTree]);

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

  return (
    <div className="app">
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
          <button className="icon-button" onClick={() => editorRef.current && undo(editorRef.current)} disabled={mode !== 'editor'} title="Undo">
            <Undo2 size={19} />
          </button>
          <button className="icon-button" onClick={() => editorRef.current && redo(editorRef.current)} disabled={mode !== 'editor'} title="Redo">
            <Redo2 size={19} />
          </button>
          <button className="icon-button primary" onClick={saveFile} disabled={!currentFile || mode !== 'editor'} title="Save">
            <Save size={19} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="Dismiss">
            <X size={18} />
          </button>
        </div>
      )}

      <main className="workspace">
        {mode === 'editor' ? (
          <CodeEditor
            path={currentFile}
            content={content}
            version={documentVersion}
            onReady={handleEditorReady}
            onChange={(next) => {
              setContent(next);
              setSaveState('dirty');
            }}
          />
        ) : (
          <TerminalView />
        )}
      </main>

      {mode === 'editor' && currentFile && <AccessoryBar editor={editorView} />}

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
    case 'error':
      return 'save failed';
    default:
      return 'ready';
  }
}

function CodeEditor({
  path,
  content,
  version,
  onReady,
  onChange
}: {
  path: string | null;
  content: string;
  version: number;
  onReady: (view: EditorView | null) => void;
  onChange: (content: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(() => {
    const lang = path ? languageFor(path) : null;
    return [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
        '.cm-content': { padding: '18px 0', minHeight: '100%' },
        '.cm-line': { padding: '0 18px' },
        '.cm-gutters': { backgroundColor: '#f7f7f4', borderRight: '1px solid #dedbd2' },
        '.cm-activeLine': { backgroundColor: '#eceae2' },
        '.cm-activeLineGutter': { backgroundColor: '#eceae2' }
      }),
      ...(lang ? [lang] : [])
    ];
  }, [path]);

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

function TerminalView() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

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
      stopViewportResize();
      socket.close();
      term.dispose();
    };
  }, []);

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
