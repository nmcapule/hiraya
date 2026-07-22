const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;
const SENSITIVE_SCHEMES = new Set(["javascript", "vbscript", "data", "blob", "file", "filesystem"]);

export type InternetShortcut = {
  url: string;
  scheme: string;
  sensitive: boolean;
};

export function parseShortcutUrl(value: string): InternetShortcut {
  const url = value.trim();
  if (!url || !ABSOLUTE_URL.test(url)) throw new Error("Enter a complete URL including its scheme, such as https://.");
  try {
    new URL(url);
  } catch {
    throw new Error("Enter a valid URL.");
  }
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  return { url, scheme, sensitive: SENSITIVE_SCHEMES.has(scheme) };
}

export function parseInternetShortcut(content: string): InternetShortcut {
  return parseShortcutUrl(readInternetShortcutUrl(content));
}

export function readInternetShortcutUrl(content: string) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  let inShortcutSection = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)]$/);
    if (section) {
      inShortcutSection = section[1].trim().toLowerCase() === "internetshortcut";
      continue;
    }
    if (!inShortcutSection) continue;
    const setting = line.match(/^\s*url\s*=\s*(.*)$/i);
    if (setting) return setting[1].trim();
  }
  throw new Error("This file does not contain a URL in an [InternetShortcut] section.");
}
