import { expect, test } from "bun:test";
import { uploadBlobDigests } from "../src/lib/blob-transfer";

test("calculates upload SHA-256 and MD5 in one Blob stream pass", async () => {
  const blob = new Blob(["updated note"]);
  const stream = blob.stream.bind(blob);
  let streamReads = 0;
  Object.defineProperty(blob, "stream", { value: () => { streamReads += 1; return stream(); } });

  expect(await uploadBlobDigests(blob)).toEqual({
    sha256: "977eefe2ccc906a187bc83d1815feaa068bbc1268f3d38f368a9bb2197f1a807",
    md5: "e2a4459894e14f0f93cc1c007eae90f8",
  });
  expect(streamReads).toBe(1);
});
