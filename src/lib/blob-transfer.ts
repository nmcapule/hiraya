import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export async function uploadBlobDigests(blob: Blob) {
  const sha256Digest = sha256.create();
  const md5Digest = md5.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sha256Digest.update(value);
      md5Digest.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { sha256: bytesToHex(sha256Digest.digest()), md5: bytesToHex(md5Digest.digest()) };
}

export async function sha256Blob(blob: Blob) {
  const digest = sha256.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      digest.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return bytesToHex(digest.digest());
}

export async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Blob transfer concurrency must be positive.");
  const results = new Array<R>(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= values.length) return;
      results[current] = await operation(values[current]);
    }
  }));
  return results;
}
