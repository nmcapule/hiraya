import type { DesktopEntry } from "../types";
import { foldEntryName, normalizeEntryName } from "./contracts";

export function validateEntryName(value: string) {
  try {
    return normalizeEntryName(value);
  } catch {
    throw new Error("Enter a valid name without slashes or control characters, up to 180 characters.");
  }
}

export function namesMatch(left: string, right: string) {
  return foldEntryName(left) === foldEntryName(right);
}

export function assertUniqueName(entries: DesktopEntry[], name: string, parentId: string | null, exceptId?: string) {
  const duplicate = entries.some(
    (entry) => entry.id !== exceptId && entry.parentId === parentId && namesMatch(entry.name, name),
  );
  if (duplicate) throw new Error(`An entry named “${name}” already exists in this folder.`);
}
