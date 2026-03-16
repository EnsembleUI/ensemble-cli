export async function processWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 16
): Promise<void> {
  if (items.length === 0) return;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  const runners: Promise<void>[] = [];

  for (let i = 0; i < limit; i += 1) {
    runners.push(
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = index;
          if (currentIndex >= items.length) break;
          index = currentIndex + 1;
          // eslint-disable-next-line no-await-in-loop
          await worker(items[currentIndex]!);
        }
      })()
    );
  }

  await Promise.all(runners);
}
