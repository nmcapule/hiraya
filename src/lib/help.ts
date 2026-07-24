import guideMarkdown from "../../docs/USER_GUIDE.md?raw";

export const HELP_SECTIONS = [
  { id: "start-here", title: "Start here", summary: "Product model and where work lives", keywords: ["local first", "server", "browser local"] },
  { id: "files-and-folders", title: "Files and folders", summary: "Hierarchy, uploads, and folder import", keywords: ["directory", "empty folders", "drag drop"] },
  { id: "desktops-and-areas", title: "Desktops and areas", summary: "Named workspaces and derived spatial regions", keywords: ["coordinates", "navigate", "arrange"] },
  { id: "sharing", title: "Sharing", summary: "Roles, invitations, and public links", keywords: ["owner", "manager", "writer", "reader", "publish"] },
  { id: "offline", title: "Offline Storage", summary: "Cache, pins, site-data risk, and shared restrictions", keywords: ["download", "storage", "clear site data"] },
  { id: "installation-and-updates", title: "Installation and updates", summary: "Install the PWA and apply releases", keywords: ["add to home screen", "reload", "PWA"] },
  { id: "apps-and-permissions", title: "Apps and permissions", summary: ".hiraya.app packages, approval, and isolation", keywords: ["install app", "capability", "uninstall"] },
  { id: "export-backup-and-recovery", title: "Export, backup, and recovery", summary: "Deployment seeds versus operator recovery", keywords: ["restore", "operator", "server backup"] },
  { id: "troubleshooting", title: "Troubleshooting", summary: "Sync, offline, storage, permissions, import, and install", keywords: ["blocked", "unavailable", "full", "unsupported"] },
] as const;

export type HelpSectionId = typeof HELP_SECTIONS[number]["id"];

export function isHelpSectionId(value: string): value is HelpSectionId {
  return HELP_SECTIONS.some((section) => section.id === value);
}

export function validateGuideLinks(markdown: string, headingIds: ReadonlySet<string>) {
  if (/!\[[^\]]*\]\(/.test(markdown)) throw new Error("The user guide must not contain images.");
  if (/\[[^\]\n]+\]\[[^\]\n]*\]/.test(markdown) || /^\[[^\]\n]+\]:\s*/m.test(markdown)) throw new Error("The user guide must use inline fragment links.");
  if (/<(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(markdown)) throw new Error("The user guide must not contain autolinks.");

  const targets = Array.from(markdown.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^)\n]*["'])?\)/g), (match) => match[1]);
  for (const target of targets) {
    if (!/^#[a-z][a-z0-9-]*$/.test(target)) throw new Error(`Unsafe user guide link: ${target}`);
    let id: string;
    try { id = decodeURIComponent(target.slice(1)); }
    catch { throw new Error(`Malformed user guide fragment: ${target}`); }
    if (!headingIds.has(id)) throw new Error(`Unknown user guide fragment: ${target}`);
  }
  return targets;
}

const guideHeadingIds = new Set(Array.from(guideMarkdown.matchAll(/^#{1,6}\s+.+?\s+\{#([a-z][a-z0-9-]*)\}\s*$/gm), (match) => match[1]));
validateGuideLinks(guideMarkdown, guideHeadingIds);

export { guideMarkdown };
