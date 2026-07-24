import { connectHiraya, HirayaSdkError, type FileHandle, type FolderHandle, type HirayaClient, type ThemeTokens } from "@hiraya/apps-sdk";
import { extractFiles, inspectArchive, type Archive, type ArchiveEntry } from "./archive";
import "./style.css";

const APP_ID = "dev.hiraya.zip-browser";
const elements = {
  archiveName: required("archive-name"), status: required("status"), summary: required("summary"), empty: required("empty-state"), browser: required("browser"), tree: required("tree"),
  entryCount: required("entry-count"), archiveSize: required("archive-size"), unpackedSize: required("unpacked-size"), selectedCount: required("selected-count"),
  open: button("open-button"), emptyOpen: button("empty-open-button"), extract: button("extract-button"), selectAll: button("select-all"),
  detailsTitle: required("details-title"), detailsList: required("details-list"), detailsPlaceholder: required("details-placeholder"),
  detailType: required("detail-type"), detailPath: required("detail-path"), detailSize: required("detail-size"), detailCompressed: required("detail-compressed"), detailModified: required("detail-modified"),
};

let hiraya: HirayaClient;
let archive: Archive | null = null;
let archiveFileName = "archive.zip";
let selected = new Set<string>();
let busy = false;

try {
  hiraya = await connectHiraya({ appId: APP_ID, requestTimeoutMs: 120_000 });
  const launch = await hiraya.app.getLaunchContext();
  applyTheme(launch.theme);
  const unsubscribeTheme = hiraya.on("theme.changed", applyTheme);
  addEventListener("pagehide", () => { unsubscribeTheme(); hiraya.close(); }, { once: true });
  await hiraya.window.setTitle("ZIP Browser");
  setStatus("Ready. Choose a ZIP archive to inspect.");
  if (launch.files[0]) await openArchive(launch.files[0]);
} catch (error) {
  fail(error);
}

elements.open.addEventListener("click", () => void pickArchive());
elements.emptyOpen.addEventListener("click", () => void pickArchive());
elements.extract.addEventListener("click", () => void extractSelection());
elements.selectAll.addEventListener("click", () => {
  if (!archive) return;
  selected = selected.size ? new Set() : new Set(archive.entries.map(({ path }) => path));
  renderTree();
});

async function pickArchive(): Promise<void> {
  if (busy || !hiraya) return;
  try {
    const handles = await hiraya.dialogs.openFile({ mimeTypes: ["application/zip"] });
    if (handles?.[0]) await openArchive(handles[0]);
  } catch (error) {
    if (!(error instanceof HirayaSdkError && error.code === "CANCELLED")) fail(error);
  }
}

async function openArchive(handle: FileHandle): Promise<void> {
  setBusy(true, "Reading and validating ZIP...");
  try {
    const metadata = await hiraya.files.stat(handle);
    if (metadata.kind !== "file") throw new Error("The selected item is not a file.");
    if (!metadata.metadata.name.toLowerCase().endsWith(".zip") && metadata.metadata.mimeType !== "application/zip") throw new Error("Choose a .zip or application/zip file.");
    const content = await hiraya.files.read(handle);
    archive = inspectArchive(content.data);
    archiveFileName = metadata.metadata.name;
    selected = new Set(archive.entries.map(({ path }) => path));
    elements.archiveName.textContent = archiveFileName;
    elements.entryCount.textContent = archive.entries.filter(({ explicit }) => explicit).length.toLocaleString();
    elements.archiveSize.textContent = formatBytes(content.data.byteLength);
    elements.unpackedSize.textContent = formatBytes(archive.totalBytes);
    elements.summary.hidden = false;
    elements.empty.hidden = true;
    elements.browser.hidden = false;
    renderTree();
    showDetails(null);
    setStatus(`Validated ${archiveFileName}. Select entries to extract.`);
  } catch (error) {
    archive = null;
    selected.clear();
    elements.summary.hidden = true;
    elements.browser.hidden = true;
    elements.empty.hidden = false;
    fail(error);
  } finally {
    setBusy(false);
  }
}

function renderTree(): void {
  if (!archive) return;
  elements.tree.replaceChildren();
  const children = new Map<string, ArchiveEntry[]>();
  for (const entry of archive.entries) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const group = children.get(parent) ?? [];
    group.push(entry);
    children.set(parent, group);
  }
  const append = (parent: string, depth: number) => {
    for (const entry of children.get(parent) ?? []) {
      const row = document.createElement("div");
      row.className = "tree-row";
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth));
      row.style.setProperty("--depth", String(depth - 1));
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(entry.path);
      checkbox.setAttribute("aria-label", `Include ${entry.name}`);
      checkbox.addEventListener("change", () => toggleEntry(entry, checkbox.checked));
      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "entry-button";
      selectButton.append(icon(entry.kind), textSpan(entry.name, "entry-name"), textSpan(entry.kind === "folder" ? folderSummary(entry.path) : formatBytes(entry.uncompressedSize), "entry-size"));
      selectButton.addEventListener("click", () => { elements.tree.querySelectorAll(".active").forEach((node) => node.classList.remove("active")); row.classList.add("active"); showDetails(entry); });
      row.append(checkbox, selectButton);
      elements.tree.append(row);
      if (entry.kind === "folder") append(entry.path, depth + 1);
    }
  };
  append("", 1);
  const selectedFiles = archive.entries.filter((entry) => entry.kind === "file" && selected.has(entry.path));
  elements.selectedCount.textContent = `${selectedFiles.length.toLocaleString()} file${selectedFiles.length === 1 ? "" : "s"} selected`;
  elements.extract.disabled = busy || selected.size === 0;
  elements.selectAll.textContent = selected.size ? "Clear selection" : "Select all";
}

function toggleEntry(entry: ArchiveEntry, include: boolean): void {
  if (!archive) return;
  const affected = entry.kind === "folder" ? archive.entries.filter(({ path }) => path === entry.path || path.startsWith(`${entry.path}/`)) : [entry];
  for (const item of affected) {
    if (include) selected.add(item.path);
    else selected.delete(item.path);
  }
  if (include) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) selected.add(parts.slice(0, index).join("/"));
  }
  renderTree();
}

async function extractSelection(): Promise<void> {
  if (!archive || busy || !selected.size) return;
  let destination: FolderHandle | null = null;
  try {
    destination = await hiraya.dialogs.openFolder();
    if (!destination) return;
    const files = archive.entries.filter((entry) => entry.kind === "file" && selected.has(entry.path));
    const selectedBytes = files.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const confirmed = await hiraya.dialogs.confirm({
      title: "Extract selected entries?",
      message: `Create a new folder containing ${files.length.toLocaleString()} file${files.length === 1 ? "" : "s"} (${formatBytes(selectedBytes)})?`,
      confirmLabel: "Extract",
    });
    if (!confirmed) return;
    setBusy(true, "Decompressing and verifying selected files...");
    const extracted = await extractFiles(archive, selected);
    const rootName = extractionFolderName(archiveFileName);
    const root = await hiraya.files.createFolder(destination, rootName, { timeoutMs: 120_000 });
    try {
      const folders = new Map<string, FolderHandle>([["", root.handle]]);
      const neededFolders = archive.entries.filter((entry) => entry.kind === "folder" && selected.has(entry.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
      for (const folder of neededFolders) {
        const parentPath = parentPathOf(folder.path);
        const parent = folders.get(parentPath);
        if (!parent) throw new Error(`Internal folder mapping failed for "${folder.path}".`);
        const created = await hiraya.files.createFolder(parent, folder.name, { timeoutMs: 120_000 });
        folders.set(folder.path, created.handle);
      }
      let completed = 0;
      for (const file of files) {
        const parent = folders.get(parentPathOf(file.path));
        const data = extracted.get(file.path);
        if (!parent || !data) throw new Error(`Internal extraction data is missing for "${file.path}".`);
        setStatus(`Writing ${++completed} of ${files.length}: ${file.name}`);
        await hiraya.files.createFile({ parent, name: file.name, data: exactBuffer(data), mimeType: "application/octet-stream" }, { timeoutMs: 120_000 });
      }
      setStatus(`Extracted ${files.length.toLocaleString()} file${files.length === 1 ? "" : "s"} to ${rootName}.`);
    } catch (error) {
      try { await hiraya.files.delete(root.handle, true, { timeoutMs: 120_000 }); } catch { /* Preserve the original actionable failure. */ }
      throw error;
    }
  } catch (error) {
    if (!(error instanceof HirayaSdkError && error.code === "CANCELLED")) fail(error);
  } finally {
    setBusy(false);
  }
}

function showDetails(entry: ArchiveEntry | null): void {
  elements.detailsList.hidden = !entry;
  elements.detailsPlaceholder.hidden = Boolean(entry);
  elements.detailsTitle.textContent = entry?.name ?? "Select an entry";
  if (!entry) return;
  elements.detailType.textContent = entry.kind === "folder" ? "Folder" : entry.compression;
  elements.detailPath.textContent = entry.path;
  elements.detailSize.textContent = entry.kind === "folder" ? folderSummary(entry.path) : formatBytes(entry.uncompressedSize);
  elements.detailCompressed.textContent = entry.kind === "folder" ? "Not applicable" : `${formatBytes(entry.compressedSize)} (${ratio(entry)}%)`;
  elements.detailModified.textContent = entry.modifiedAt?.toLocaleString() ?? "Not provided";
}

function folderSummary(path: string): string {
  if (!archive) return "0 items";
  const count = archive.entries.filter((entry) => parentPathOf(entry.path) === path).length;
  return `${count} item${count === 1 ? "" : "s"}`;
}

function setBusy(value: boolean, message?: string): void {
  busy = value;
  elements.open.disabled = value;
  elements.emptyOpen.disabled = value;
  elements.extract.disabled = value || !selected.size;
  if (message) setStatus(message);
}

function fail(error: unknown): void {
  const message = error instanceof HirayaSdkError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : String(error);
  setStatus(message, true);
}

function setStatus(message: string, danger = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", danger);
}

function applyTheme(theme: ThemeTokens): void {
  document.documentElement.dataset.theme = theme.mode;
  for (const [name, value] of Object.entries(theme)) if (name !== "mode") document.documentElement.style.setProperty(`--hiraya-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
}

function icon(kind: ArchiveEntry["kind"]): HTMLElement {
  const value = document.createElement("span");
  value.className = `entry-icon ${kind}`;
  value.textContent = kind === "folder" ? "F" : "D";
  value.setAttribute("aria-hidden", "true");
  return value;
}

function textSpan(value: string, className: string): HTMLSpanElement {
  const span = document.createElement("span"); span.className = className; span.textContent = value; return span;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

function ratio(entry: ArchiveEntry): string {
  return entry.uncompressedSize ? ((entry.compressedSize / entry.uncompressedSize) * 100).toFixed(1) : "0.0";
}

function parentPathOf(path: string): string {
  const separator = path.lastIndexOf("/"); return separator < 0 ? "" : path.slice(0, separator);
}

function extractionFolderName(name: string): string {
  const base = name.replace(/\.zip$/i, "").trim() || "Archive";
  return `${base.slice(0, 240)} extracted`;
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing UI element: ${id}`); return value;
}

function button(id: string): HTMLButtonElement {
  const value = required(id); if (!(value instanceof HTMLButtonElement)) throw new Error(`UI element is not a button: ${id}`); return value;
}
