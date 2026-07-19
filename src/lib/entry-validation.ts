import type { DesktopEntry } from "../types";

export function validateEntryName(value: string) {
  const name = value.trim();

  if (!name) throw new Error("Enter a name.");
  if (name === "." || name === "..") throw new Error("Choose a different name.");
  if (name.includes("/") || name.includes("\\") || [...name].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Names cannot contain slashes or control characters.");
  }
  if (name.length > 180) throw new Error("Keep the name under 180 characters.");

  return name;
}

export function namesMatch(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export function assertUniqueName(entries: DesktopEntry[], name: string, parentId: string | null, exceptId?: string) {
  const duplicate = entries.some(
    (entry) => entry.id !== exceptId && entry.parentId === parentId && namesMatch(entry.name, name),
  );
  if (duplicate) throw new Error(`An entry named “${name}” already exists in this folder.`);
}
