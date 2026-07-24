import { useDeferredValue, useId, useRef, useState } from "react";
import { File, Folder, MagnifyingGlass, SquaresFour, TerminalWindow, X } from "@phosphor-icons/react";
import type { DesktopEntry } from "../types";
import { filterAndGroupSearchItems, type SearchCategory, type SearchItem } from "../ui/panel-data";
import { useModalDialog } from "../ui/modal-dialog";
import type { CommandId, CommandItem } from "../apps/commands";

export type SearchPaletteWindow = { id: string; title: string; detail?: string };

export type SearchCommandPaletteProps<Id extends CommandId> = {
  entries: readonly DesktopEntry[];
  windows: readonly SearchPaletteWindow[];
  commands: readonly CommandItem<Id>[];
  onOpenEntry: (entry: DesktopEntry) => void;
  onFocusWindow: (windowId: string) => void;
  onRunCommand: (commandId: Id) => void;
  onClose: () => void;
};

type PaletteItem = SearchItem & { action: () => void; disabled?: boolean };

const CATEGORY_LABELS: Record<SearchCategory, string> = {
  files: "Files",
  folders: "Folders",
  windows: "Open windows",
  commands: "Commands",
};

function ResultIcon({ category }: { category: SearchCategory }) {
  if (category === "files") return <File size={18} weight="duotone" aria-hidden="true" />;
  if (category === "folders") return <Folder size={18} weight="duotone" aria-hidden="true" />;
  if (category === "windows") return <SquaresFour size={18} weight="duotone" aria-hidden="true" />;
  return <TerminalWindow size={18} weight="duotone" aria-hidden="true" />;
}

export function SearchCommandPalette<Id extends CommandId>({ entries, windows, commands, onOpenEntry, onFocusWindow, onRunCommand, onClose }: SearchCommandPaletteProps<Id>) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const listId = useId();
  useModalDialog(backdropRef, dialogRef, onClose);

  const items: PaletteItem[] = [
    ...entries.map((entry): PaletteItem => ({
      id: `entry:${entry.id}`,
      category: entry.kind === "file" ? "files" : "folders",
      label: entry.name,
      detail: entry.kind === "file" ? entry.mimeType : "Folder",
      action: () => onOpenEntry(entry),
    })),
    ...windows.map((window): PaletteItem => ({ id: `window:${window.id}`, category: "windows", label: window.title, detail: window.detail, action: () => onFocusWindow(window.id) })),
    ...commands.map((command): PaletteItem => ({ id: `command:${command.id}`, category: "commands", label: command.label, detail: command.detail, keywords: command.keywords, disabled: !command.enabled, action: () => onRunCommand(command.id) })),
  ];
  const groups = filterAndGroupSearchItems(items, deferredQuery);
  const results = groups.flatMap((group) => group.items);
  const selectedIndex = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);
  const selectedId = selectedIndex >= 0 ? `${listId}-option-${selectedIndex}` : undefined;

  function choose(item: PaletteItem) {
    if (item.disabled) return;
    item.action();
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const currentResults = event.key === "Enter"
      ? filterAndGroupSearchItems(items, query).flatMap((group) => group.items) as PaletteItem[]
      : results;
    if (currentResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (Math.min(index, currentResults.length - 1) + 1) % currentResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (Math.min(index, currentResults.length - 1) - 1 + currentResults.length) % currentResults.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(currentResults.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(currentResults[Math.min(activeIndex, currentResults.length - 1)]);
    }
  }

  let resultIndex = 0;
  return <div ref={backdropRef} className="modal-backdrop command-palette-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="file-window command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="command-palette__header">
        <MagnifyingGlass size={20} aria-hidden="true" />
        <label className="sr-only" htmlFor={`${titleId}-query`} id={titleId}>Search files, folders, windows, and commands</label>
        <input id={`${titleId}-query`} type="search" value={query} placeholder="Search Hiraya" autoComplete="off" autoFocus aria-controls={listId} aria-activedescendant={selectedId} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleKeyDown} />
        <button className="icon-button" type="button" aria-label="Close search" onClick={onClose}><X size={18} /></button>
      </header>
      <div id={listId} className="command-palette__results" role="listbox" aria-label="Search results">
        {groups.length === 0 ? <div className="command-palette__empty" role="status">
          <MagnifyingGlass size={28} weight="duotone" aria-hidden="true" />
          <strong>No results found</strong>
          <span>Try a file name, window, or command.</span>
        </div> : groups.map((group) => <section className="command-palette__group" role="group" aria-labelledby={`${listId}-${group.category}`} key={group.category}>
          <h2 id={`${listId}-${group.category}`}>{CATEGORY_LABELS[group.category]}</h2>
          {group.items.map((item) => {
            const index = resultIndex++;
            return <button id={`${listId}-option-${index}`} className="command-palette__result" type="button" role="option" aria-selected={index === selectedIndex} aria-disabled={item.disabled || undefined} disabled={item.disabled} data-active={index === selectedIndex || undefined} key={item.id} onPointerMove={() => setActiveIndex(index)} onClick={() => choose(item)}>
              <ResultIcon category={item.category} />
              <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
            </button>;
          })}
        </section>)}
      </div>
    </section>
  </div>;
}
