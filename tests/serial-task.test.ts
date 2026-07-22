import { describe, expect, test } from "bun:test";
import { createSerialTaskQueue } from "../src/lib/serial-task";

describe("serial task queue", () => {
  test("runs activations strictly in arrival order with unique monotonic tokens", async () => {
    const queue = createSerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.run(async (token) => {
      events.push(`start:${token}:one`);
      await firstGate;
      events.push(`finish:${token}:one`);
      return "one";
    });
    const second = queue.run(async (token) => {
      events.push(`start:${token}:two`);
      events.push(`finish:${token}:two`);
      return "two";
    });

    await Promise.resolve();
    expect(events).toEqual(["start:1:one"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["one", "two"]);
    expect(events).toEqual(["start:1:one", "finish:1:one", "start:2:two", "finish:2:two"]);
    await queue.drain();
  });

  test("continues deterministically after a rejected activation", async () => {
    const queue = createSerialTaskQueue();
    const tokens: number[] = [];
    const failed = queue.run(async (token) => { tokens.push(token); throw new Error("failed"); });
    const recovered = queue.run(async (token) => { tokens.push(token); return "recovered"; });
    await expect(failed).rejects.toThrow("failed");
    expect(await recovered).toBe("recovered");
    expect(tokens).toEqual([1, 2]);
  });
});
