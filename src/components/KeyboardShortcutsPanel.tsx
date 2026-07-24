import { useDeferredValue, useId, useState } from "react";
import { Keyboard, MagnifyingGlass, X } from "@phosphor-icons/react";
import { filterAndGroupShortcuts, type KeyboardShortcut } from "../ui/panel-data";

export type KeyboardShortcutsPanelProps = { shortcuts: readonly KeyboardShortcut[] };

export function KeyboardShortcutsPanel({ shortcuts }: KeyboardShortcutsPanelProps) {
  const [query, setQuery] = useState("");
  const groups = filterAndGroupShortcuts(shortcuts, useDeferredValue(query));
  const titleId = useId();
  return <section className="keyboard-shortcuts-panel" aria-labelledby={titleId}>
    <header><Keyboard size={24} weight="duotone" aria-hidden="true" /><div><h2 id={titleId}>Keyboard shortcuts</h2><p>Work across Hiraya without reaching for the pointer.</p></div></header>
    <label className="activity-search keyboard-shortcuts-panel__search">
      <MagnifyingGlass size={16} aria-hidden="true" /><span className="sr-only">Search keyboard shortcuts</span>
      <input type="search" value={query} placeholder="Search shortcuts" onChange={(event) => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="Clear shortcut search" onClick={() => setQuery("")}><X size={14} /></button>}
    </label>
    {groups.length === 0 ? <div className="keyboard-shortcuts-panel__empty" role="status"><strong>No shortcuts found</strong><span>Try another action or key.</span></div> : <div className="keyboard-shortcuts-panel__groups">
      {groups.map((group, index) => <section key={group.label} aria-labelledby={`${titleId}-group-${index}`}>
        <h3 id={`${titleId}-group-${index}`}>{group.label}</h3>
        <dl>{group.shortcuts.map((shortcut) => <div key={shortcut.id}><dt>{shortcut.label}</dt><dd aria-label={shortcut.keys.join(" then ")}>{shortcut.keys.map((key, index) => <span key={`${key}-${index}`}>{index > 0 && <span aria-hidden="true">+</span>}<kbd>{key}</kbd></span>)}</dd></div>)}</dl>
      </section>)}
    </div>}
  </section>;
}
