export function fileFromEntry(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

export async function readAllDirectoryEntries(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const result: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return result;
    result.push(...batch);
  }
}
