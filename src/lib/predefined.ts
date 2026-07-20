import { strToU8, zip, type Zippable } from "fflate";
import { readDesktopSnapshot } from "./opfs";
import { parsePredefinedManifest, type PredefinedFileEntry, type PredefinedManifest } from "./predefined-manifest";
import type { DesktopEntry } from "../types";

const EXPORT_ROOT = "hiraya-predefined";

function logicalPath(entry: DesktopEntry, byId: Map<string, DesktopEntry>) {
  const segments = [entry.name];
  let parentId = entry.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "folder") throw new Error("The desktop contains an invalid folder hierarchy.");
    segments.unshift(parent.name);
    parentId = parent.parentId;
  }
  return segments.join("/");
}

function createZip(files: Zippable) {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

export async function exportPredefinedDesktop() {
  const snapshot = await readDesktopSnapshot();
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const archive: Zippable = { [`${EXPORT_ROOT}/`]: new Uint8Array() };
  const entries = await Promise.all(snapshot.entries.map(async (entry) => {
    const path = logicalPath(entry, byId);
    if (entry.kind === "folder") {
      archive[`${EXPORT_ROOT}/content/${path}/`] = new Uint8Array();
      return entry;
    }
    const content = snapshot.contents.get(entry.id);
    if (!content) throw new Error(`The contents of “${entry.name}” could not be read.`);
    archive[`${EXPORT_ROOT}/content/${path}`] = new Uint8Array(await content.arrayBuffer());
    return { ...entry, contentUrl: `content/${path}` } satisfies PredefinedFileEntry;
  }));
  const manifest = parsePredefinedManifest({
    version: 2,
    layout: snapshot.layout,
    editorSettings: snapshot.editorSettings,
    entries,
  }) satisfies PredefinedManifest;
  archive[`${EXPORT_ROOT}/manifest.json`] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

  const zipped = await createZip(archive);
  const bytes = zipped.slice().buffer as ArrayBuffer;
  return new Blob([bytes], { type: "application/zip" });
}
