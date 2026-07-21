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

export function updateInternetShortcut(content: string, value: string) {
  const { url } = parseShortcutUrl(value);
  return updateInternetShortcutDraft(content, url);
}

export function updateInternetShortcutDraft(content: string, value: string) {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom ? content.slice(1) : content;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  let sectionStart = -1;
  let sectionEnd = lines.length;
  let urlLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].trim().match(/^\[([^\]]+)]$/);
    if (section) {
      if (sectionStart >= 0) {
        sectionEnd = index;
        break;
      }
      if (section[1].trim().toLowerCase() === "internetshortcut") sectionStart = index;
      continue;
    }
    if (sectionStart >= 0 && /^\s*url\s*=/i.test(lines[index])) {
      urlLine = index;
      break;
    }
  }

  if (urlLine >= 0) lines[urlLine] = `URL=${value}`;
  else if (sectionStart >= 0) lines.splice(sectionEnd, 0, `URL=${value}`);
  else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push("[InternetShortcut]", `URL=${value}`);
  }
  return bom + lines.join(newline) + newline;
}
