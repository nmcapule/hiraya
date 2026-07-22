export type LocalPreviewTarget = {
  kind: "local";
  path: string;
  label: string;
};

export type ExternalPreviewTarget = {
  kind: "image" | "video" | "audio" | "youtube" | "vimeo" | "site";
  sourceUrl: string;
  previewUrl: string;
  label: string;
  host: string;
};

export type EmbeddedPreviewTarget = LocalPreviewTarget | ExternalPreviewTarget;

const VIDEO_EXTENSIONS = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
const AUDIO_EXTENSIONS = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac)$/i;
const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

function youtubeVideoId(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const [section, id] = url.pathname.split("/").filter(Boolean);
  return ["embed", "shorts", "live"].includes(section) ? id ?? null : null;
}

function vimeoVideoId(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[0] === "video" ? parts[1] : parts[0];
  return id && /^\d+$/.test(id) ? id : null;
}

function externalTarget(destination: string, label: string, image: boolean): ExternalPreviewTarget | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;

  const sourceUrl = url.href;
  const common = { sourceUrl, label: label || url.hostname, host: url.hostname };
  if (image || IMAGE_EXTENSIONS.test(url.pathname)) return { ...common, kind: "image", previewUrl: sourceUrl };

  const youtubeId = youtubeVideoId(url);
  if (youtubeId && /^[a-z\d_-]+$/i.test(youtubeId)) {
    return { ...common, kind: "youtube", previewUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}` };
  }
  const vimeoId = vimeoVideoId(url);
  if (vimeoId) return { ...common, kind: "vimeo", previewUrl: `https://player.vimeo.com/video/${vimeoId}` };
  if (VIDEO_EXTENSIONS.test(url.pathname)) return { ...common, kind: "video", previewUrl: sourceUrl };
  if (AUDIO_EXTENSIONS.test(url.pathname)) return { ...common, kind: "audio", previewUrl: sourceUrl };
  return { ...common, kind: "site", previewUrl: sourceUrl };
}

export function markdownPreviewTargets(text: string, externalEnabled: boolean): EmbeddedPreviewTarget[] {
  const targets: EmbeddedPreviewTarget[] = [];
  const pattern = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const destination = (match[3] ?? match[4]).replace(/\\([\\()])/g, "$1");
    if (!destination || destination.startsWith("#") || destination.startsWith("/") || destination.startsWith("\\")) continue;
    if (!/^[a-z][a-z\d+.-]*:/i.test(destination)) {
      targets.push({ kind: "local", path: destination, label: match[2] || destination });
      continue;
    }
    if (!externalEnabled) continue;
    const target = externalTarget(destination, match[2], match[1] === "!");
    if (target) targets.push(target);
  }
  return targets;
}
