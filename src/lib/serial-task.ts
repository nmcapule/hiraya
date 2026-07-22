export function createSerialTaskQueue() {
  let sequence = 0;
  let work: Promise<void> = Promise.resolve();

  return {
    run<T>(task: (token: number) => Promise<T>): Promise<T> {
      const token = ++sequence;
      const result = work.then(() => task(token), () => task(token));
      work = result.then(() => undefined, () => undefined);
      return result;
    },
    drain() {
      return work;
    },
  };
}
