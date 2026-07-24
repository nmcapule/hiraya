import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileEntry } from "../types";

type Props = {
  content: string;
  externalEmbeddedPreviews: boolean;
  onResolveLink: (path: string) => Promise<{ file: FileEntry; blob: Blob }>;
  onOpenLinkedFile: (file: FileEntry) => void;
  onLinkError?: (message: string) => void;
  onAnchorLink?: (href: string) => void;
};

function isExternal(value: string) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

function LocalImage({ src, alt, externalEmbeddedPreviews, onResolveLink }: {
  src: string;
  alt: string;
  externalEmbeddedPreviews: boolean;
  onResolveLink: Props["onResolveLink"];
}) {
  const [resolvedSrc, setResolvedSrc] = useState("");
  useEffect(() => {
    if (isExternal(src)) {
      setResolvedSrc(externalEmbeddedPreviews ? src : "");
      return;
    }
    let active = true;
    let objectUrl = "";
    void onResolveLink(src).then(({ blob }) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setResolvedSrc(objectUrl);
    }).catch(() => setResolvedSrc(""));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [externalEmbeddedPreviews, onResolveLink, src]);

  return resolvedSrc ? <img src={resolvedSrc} alt={alt} /> : <span className="markdown-renderer__missing-media">{alt || src}</span>;
}

function headingId(children: ReactNode) {
  const text = Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return Children.toArray(child.props.children).join("");
    return "";
  }).join("");
  const explicit = text.match(/\s*\{#([a-z][a-z0-9-]*)\}\s*$/);
  return explicit?.[1] ?? text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function headingChildren(children: ReactNode) {
  return Children.map(children, (child) => typeof child === "string" ? child.replace(/\s*\{#[a-z][a-z0-9-]*\}\s*$/, "") : child);
}

export function MarkdownRenderer({ content, externalEmbeddedPreviews, onResolveLink, onOpenLinkedFile, onLinkError, onAnchorLink }: Props) {
  const [linkError, setLinkError] = useState("");

  async function openLocalLink(href: string) {
    setLinkError("");
    onLinkError?.("");
    try {
      const { file } = await onResolveLink(href);
      onOpenLinkedFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not open ${href}.`;
      setLinkError(message);
      onLinkError?.(message);
    }
  }

  return (
    <article className="markdown-renderer">
      {linkError && !onLinkError && <p className="markdown-renderer__missing-media" role="alert">{linkError}</p>}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={headingId(children)}>{headingChildren(children)}</h1>,
          h2: ({ children }) => <h2 id={headingId(children)}>{headingChildren(children)}</h2>,
          h3: ({ children }) => <h3 id={headingId(children)}>{headingChildren(children)}</h3>,
          h4: ({ children }) => <h4 id={headingId(children)}>{headingChildren(children)}</h4>,
          a: ({ href = "", children }: { href?: string; children?: ReactNode }) => isExternal(href) || href.startsWith("#")
            ? <a href={href} target={isExternal(href) ? "_blank" : undefined} rel={isExternal(href) ? "noopener noreferrer" : undefined} onClick={href.startsWith("#") && onAnchorLink ? (event) => { event.preventDefault(); onAnchorLink(href); } : undefined}>{children}</a>
            : <a href={href} onClick={(event) => { event.preventDefault(); void openLocalLink(href); }}>{children}</a>,
          img: ({ src = "", alt = "" }: { src?: string; alt?: string }) => (
            <LocalImage src={src} alt={alt} externalEmbeddedPreviews={externalEmbeddedPreviews} onResolveLink={onResolveLink} />
          ),
        }}
      >{content}</ReactMarkdown>
    </article>
  );
}
