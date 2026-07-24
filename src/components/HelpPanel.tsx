import { useDeferredValue, useEffect, useRef, useState } from "react";
import { BookOpenText, MagnifyingGlass } from "@phosphor-icons/react";
import { HELP_SECTIONS, guideMarkdown, isHelpSectionId, type HelpSectionId } from "../lib/help";
import { MarkdownRenderer } from "./MarkdownRenderer";

type Props = { section: HelpSectionId; onSectionChange: (section: HelpSectionId) => void };

export function HelpPanel({ section, onSectionChange }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const searchTerms = deferredQuery.split(/\s+/).filter(Boolean);
  const sections = searchTerms.length ? HELP_SECTIONS.filter((item) => {
    const text = [item.title, item.summary, ...item.keywords].join(" ").toLowerCase();
    return searchTerms.every((term) => text.includes(term));
  }) : HELP_SECTIONS;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      focusHeading(section);
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);

  function focusHeading(id: string) {
    const heading = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((element) => element.id === id);
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }

  function openAnchor(href: string) {
    let id: string;
    try { id = decodeURIComponent(href.slice(1)); }
    catch { return; }
    if (isHelpSectionId(id)) onSectionChange(id);
    else focusHeading(id);
  }

  return <div className="help-panel" ref={panelRef}>
    <aside className="help-panel__navigation" aria-label="User guide sections">
      <header><BookOpenText size={22} aria-hidden="true" /><div><h2>User guide</h2><p>Bundled for offline access</p></div></header>
      <label className="help-panel__search"><MagnifyingGlass size={16} aria-hidden="true" /><span className="visually-hidden">Filter guide sections</span><input type="search" value={query} placeholder="Filter sections" onChange={(event) => setQuery(event.target.value)} /></label>
      <nav aria-label="Guide contents">
        {sections.map((item) => <button type="button" aria-current={section === item.id ? "location" : undefined} key={item.id} onClick={() => onSectionChange(item.id)}><strong>{item.title}</strong><small>{item.summary}</small></button>)}
        {!sections.length && <p role="status">No guide sections match that search.</p>}
      </nav>
    </aside>
    <div className="help-panel__document">
      <MarkdownRenderer content={guideMarkdown} externalEmbeddedPreviews={false} onResolveLink={async () => { throw new Error("The bundled guide has no file links."); }} onOpenLinkedFile={() => undefined} onAnchorLink={openAnchor} />
    </div>
  </div>;
}
