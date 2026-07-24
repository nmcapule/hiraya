import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileEntry } from "../types";

type Props = {
  content: string;
  externalEmbeddedPreviews: boolean;
  onResolveLink: (path: string) => Promise<{ file: FileEntry; blob: Blob }>;
  onOpenLinkedFile: (file: FileEntry) => void;
  onLinkError?: (message: string) => void;
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

export function MarkdownRenderer({ content, externalEmbeddedPreviews, onResolveLink, onOpenLinkedFile, onLinkError }: Props) {
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
          a: ({ href = "", children }: { href?: string; children?: ReactNode }) => isExternal(href) || href.startsWith("#")
            ? <a href={href} target={isExternal(href) ? "_blank" : undefined} rel={isExternal(href) ? "noopener noreferrer" : undefined}>{children}</a>
            : <a href={href} onClick={(event) => { event.preventDefault(); void openLocalLink(href); }}>{children}</a>,
          img: ({ src = "", alt = "" }: { src?: string; alt?: string }) => (
            <LocalImage src={src} alt={alt} externalEmbeddedPreviews={externalEmbeddedPreviews} onResolveLink={onResolveLink} />
          ),
        }}
      >{content}</ReactMarkdown>
    </article>
  );
}
