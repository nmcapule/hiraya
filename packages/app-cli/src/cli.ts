#!/usr/bin/env bun
import { inspectAppInput, packageApp, relativeOutput } from "./filesystem";

function usage(): never {
  console.error("Usage: hiraya-app <validate|inspect> <dir-or-.hiraya.app>\n       hiraya-app package <app-dir> [output.hiraya.app]");
  process.exit(2);
}

const [command, input, output, ...extra] = process.argv.slice(2);
if (!command || !input || extra.length > 0 || (command !== "package" && output !== undefined)) usage();

try {
  if (command === "package") {
    const result = await packageApp(input, output);
    console.log(`${relativeOutput(result.destination)}\nsha256 ${result.inspection.digest}`);
  } else if (command === "validate") {
    const inspection = await inspectAppInput(input);
    console.log(`Valid ${inspection.manifest.id}@${inspection.manifest.version}\nsha256 ${inspection.digest}`);
  } else if (command === "inspect") {
    const inspection = await inspectAppInput(input);
    console.log(JSON.stringify({
      manifest: inspection.manifest,
      digest: { algorithm: "SHA-256", value: inspection.digest },
      entries: inspection.entryCount,
      compressedBytes: inspection.compressedBytes,
      expandedBytes: inspection.expandedBytes,
    }, null, 2));
  } else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
