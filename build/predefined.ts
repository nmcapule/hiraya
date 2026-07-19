import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { parsePredefinedManifest, type PredefinedFileEntry } from "../src/lib/predefined-manifest";

const PUBLIC_ID = "virtual:hiraya-predefined";
const RESOLVED_ID = `\0${PUBLIC_ID}`;

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function predefinedDesktopPlugin(projectRoot: string, configuredDirectory?: string): Plugin {
  let sourceDirectory: string | null = null;

  return {
    name: "hiraya-predefined-desktop",
    enforce: "pre",
    async configResolved() {
      if (!configuredDirectory?.trim()) return;
      const root = await realpath(projectRoot);
      const candidate = path.resolve(root, configuredDirectory);
      if (!isInside(root, candidate)) throw new Error("HIRAYA_PREDEFINED_DIR must point to a directory inside the repository.");
      const sourceStats = await lstat(candidate);
      if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) throw new Error("HIRAYA_PREDEFINED_DIR must point to a regular directory, not a symbolic link.");
      const resolvedSource = await realpath(candidate);
      if (!isInside(root, resolvedSource)) throw new Error("HIRAYA_PREDEFINED_DIR resolves outside the repository.");
      sourceDirectory = resolvedSource;
    },
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return;
      if (!sourceDirectory) return "export default null;";

      const manifestPath = path.join(sourceDirectory, "manifest.json");
      const manifestStats = await lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
        throw new Error(`Predefined desktop manifest at ${manifestPath} must be a regular file, not a symbolic link.`);
      }
      this.addWatchFile(manifestPath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(`Could not read predefined desktop manifest at ${manifestPath}.`, { cause: error });
      }
      const manifest = parsePredefinedManifest(parsed);
      const imports: string[] = [];

      for (const [index, entry] of manifest.entries.entries()) {
        if (entry.kind !== "file") continue;
        const contentUrl = (entry as PredefinedFileEntry).contentUrl;
        if (path.isAbsolute(contentUrl) || contentUrl.includes("\\") || /[?#]/.test(contentUrl) || /^[a-z][a-z\d+.-]*:/i.test(contentUrl)) {
          throw new Error(`Predefined file “${entry.name}” must use a relative contentUrl without a query or fragment.`);
        }
        const assetPath = path.resolve(sourceDirectory, contentUrl);
        if (!isInside(sourceDirectory, assetPath)) throw new Error(`Predefined file “${entry.name}” points outside HIRAYA_PREDEFINED_DIR.`);
        const unresolvedStats = await lstat(assetPath);
        if (unresolvedStats.isSymbolicLink()) throw new Error(`Predefined file “${entry.name}” cannot be a symbolic link.`);
        const resolvedAsset = await realpath(assetPath);
        if (!isInside(sourceDirectory, resolvedAsset)) throw new Error(`Predefined file “${entry.name}” resolves outside HIRAYA_PREDEFINED_DIR.`);
        const stats = await lstat(resolvedAsset);
        if (!stats.isFile()) throw new Error(`Predefined file “${entry.name}” does not refer to a regular file.`);
        if (stats.size !== entry.size) throw new Error(`Predefined file “${entry.name}” has size ${stats.size}, but its manifest declares ${entry.size}.`);
        this.addWatchFile(resolvedAsset);
        imports.push(`import asset${index} from ${JSON.stringify(`${resolvedAsset}?url`)};`);
      }

      const assignments = manifest.entries.flatMap((entry, index) => entry.kind === "file" ? [`manifest.entries[${index}].contentUrl = asset${index};`] : []);
      return `${imports.join("\n")}\nconst manifest = ${JSON.stringify(manifest)};\n${assignments.join("\n")}\nexport default manifest;`;
    },
  };
}
